const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const nodemailer = require("nodemailer");
const { MercadoPagoConfig, Preference } = require("mercadopago");

const ROOT = __dirname;
const CHECKOUT_CATALOG = require("./checkout-catalog.json");
const scrypt = promisify(crypto.scrypt);

function loadLocalEnvironment() {
    const envPath = path.join(ROOT, ".env");
    if (!fs.existsSync(envPath)) return;

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || match[1] in process.env) continue;

        const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
        process.env[match[1]] = value;
    }
}

loadLocalEnvironment();

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "12kb" }));

const authDatabasePath = process.env.AUTH_DB_PATH || path.join(ROOT, "data", "accounts.sqlite");
const authDataDirectory = path.dirname(authDatabasePath);
fs.mkdirSync(authDataDirectory, { recursive: true });
const authDatabase = new DatabaseSync(authDatabasePath);
authDatabase.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        phone TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS password_resets (
        email TEXT PRIMARY KEY,
        salt TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
`);

const SESSION_COOKIE = "pcgs_session";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_CODE_DURATION_MS = 10 * 60 * 1000;
const PASSWORD_SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const rateLimitBuckets = new Map();
let emailTransporter;

function normalizeEmail(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeName(value) {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function validEmail(value) {
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function hashToken(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derivedKey = await scrypt(password, salt, 64, PASSWORD_SCRYPT_OPTIONS);
    return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
    const [saltHex, keyHex] = storedHash.split(":");
    if (!/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(keyHex)) return false;
    const expectedKey = Buffer.from(keyHex, "hex");
    const actualKey = await scrypt(password, Buffer.from(saltHex, "hex"), expectedKey.length, PASSWORD_SCRYPT_OPTIONS);
    return crypto.timingSafeEqual(actualKey, expectedKey);
}

function getClientKey(request) {
    return request.ip || request.socket.remoteAddress || "unknown";
}

function canUseLocalRecovery(request) {
    if (process.env.NODE_ENV === "production") return false;
    const address = request.socket.remoteAddress || "";
    return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function checkRateLimit(request, response, bucketName, limit, windowMs) {
    const now = Date.now();
    const key = `${bucketName}:${getClientKey(request)}`;
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        rateLimitBuckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count <= limit) return true;

    response.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    response.status(429).json({ error: "Demasiados intentos. Esperá unos minutos y volvé a probar." });
    if (rateLimitBuckets.size > 2000) {
        for (const [bucketKey, value] of rateLimitBuckets) {
            if (value.resetAt <= now) rateLimitBuckets.delete(bucketKey);
        }
    }
    return false;
}

function setSessionCookie(request, response, token) {
    const secure = request.secure ? "; Secure" : "";
    response.set(
        "Set-Cookie",
        `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_DURATION_MS / 1000)}${secure}`
    );
}

function clearSessionCookie(request, response) {
    const secure = request.secure ? "; Secure" : "";
    response.set("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function getSessionToken(request) {
    const cookies = request.headers.cookie || "";
    const match = cookies.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})(?:;|$)`, "i"));
    return match ? match[1] : "";
}

function createSession(userId, request, response) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    authDatabase.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(hashToken(token), userId, expiresAt);
    setSessionCookie(request, response, token);
}

function getAuthenticatedUser(request) {
    const token = getSessionToken(request);
    if (!token) return null;

    const session = authDatabase.prepare(`
        SELECT users.id, users.name, users.email, sessions.expires_at
        FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
    `).get(hashToken(token));
    if (!session) return null;
    if (session.expires_at <= Date.now()) {
        authDatabase.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
        return null;
    }
    return session;
}

function getEmailTransporter() {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT) || 587;
    const user = process.env.SMTP_USER;
    const password = process.env.SMTP_APP_PASSWORD;
    const from = process.env.SMTP_FROM || user;
    if (!host || !user || !password || !from) return null;
    if (!emailTransporter) {
        emailTransporter = nodemailer.createTransport({
            host,
            port,
            secure: port === 465,
            auth: { user, pass: password }
        });
    }
    return { transporter: emailTransporter, from };
}

function sendRecoveryCode(email, code) {
    const mail = getEmailTransporter();
    if (!mail) throw new Error("Falta configurar SMTP_HOST, SMTP_USER, SMTP_APP_PASSWORD y SMTP_FROM en .env.");
    return mail.transporter.sendMail({
        from: mail.from,
        to: email,
        subject: "Código para recuperar tu cuenta · PC Gamer Shop",
        text: `Tu código de recuperación es ${code}. Vence en 10 minutos. Si no solicitaste este código, ignorá este correo.`,
        html: `<p>Tu código de recuperación de PC Gamer Shop es:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>Vence en 10 minutos. Si no solicitaste este código, ignorá este correo.</p>`
    });
}

function asyncRoute(handler) {
    return (request, response, next) => {
        Promise.resolve(handler(request, response, next)).catch(next);
    };
}

app.get("/", (_request, response) => response.sendFile(path.join(ROOT, "index.html")));
app.get("/index.html", (_request, response) => response.sendFile(path.join(ROOT, "index.html")));
app.get("/login.html", (_request, response) => response.sendFile(path.join(ROOT, "login.html")));
app.get("/register.html", (_request, response) => response.sendFile(path.join(ROOT, "register.html")));
app.get("/recover.html", (_request, response) => response.sendFile(path.join(ROOT, "recover.html")));
app.get("/contact.html", (_request, response) => response.sendFile(path.join(ROOT, "contact.html")));
app.get("/products.json", (_request, response) => response.sendFile(path.join(ROOT, "products.json")));
app.get("/products.js", (_request, response) => response.sendFile(path.join(ROOT, "products.js")));
app.use("/assets", express.static(path.join(ROOT, "assets"), { index: false }));
app.get("/healthz", (_request, response) => response.status(200).json({ status: "ok" }));

app.post("/api/register", asyncRoute(async (request, response) => {
    if (!checkRateLimit(request, response, "register", 8, 15 * 60 * 1000)) return;

    const name = normalizeName(request.body?.name);
    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;
    if (name.length < 2 || name.length > 80) {
        response.status(400).json({ error: "El nombre debe tener entre 2 y 80 caracteres." });
        return;
    }
    if (!validEmail(email)) {
        response.status(400).json({ error: "Ingresá un correo electrónico válido." });
        return;
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
        response.status(400).json({ error: "La contraseña debe tener entre 8 y 128 caracteres." });
        return;
    }

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    try {
        authDatabase.prepare(`
            INSERT INTO users (id, name, name_key, email, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(userId, name, name.toLocaleLowerCase("es"), email, passwordHash, Date.now());
    } catch (error) {
        if (error.errcode === 2067 || /UNIQUE constraint failed/.test(error.message)) {
            response.status(409).json({
                error: "Ese correo o nombre ya está asociado a una cuenta. Iniciá sesión o recuperá tu contraseña."
            });
            return;
        }
        throw error;
    }

    createSession(userId, request, response);
    response.status(201).json({ authenticated: true, user: { name, email } });
}));

app.post("/api/login", asyncRoute(async (request, response) => {
    if (!checkRateLimit(request, response, "login", 10, 15 * 60 * 1000)) return;

    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;
    if (!validEmail(email) || typeof password !== "string" || password.length > 128) {
        response.status(400).json({ error: "Ingresá un correo y contraseña válidos." });
        return;
    }

    const user = authDatabase.prepare(
        "SELECT id, name, email, password_hash FROM users WHERE email = ?"
    ).get(email);
    const passwordMatches = user
        ? await verifyPassword(password, user.password_hash)
        : false;
    if (!passwordMatches) {
        response.status(401).json({ error: "El correo o la contraseña no son correctos." });
        return;
    }

    createSession(user.id, request, response);
    response.json({ authenticated: true, user: { name: user.name, email: user.email } });
}));

app.get("/api/session", (request, response) => {
    const user = getAuthenticatedUser(request);
    if (!user) {
        response.json({ authenticated: false });
        return;
    }
    response.json({ authenticated: true, user: { name: user.name, email: user.email } });
});

app.get("/api/profile", (request, response) => {
    const user = getAuthenticatedUser(request);
    if (!user) {
        response.status(401).json({ error: "Iniciá sesión para ver los datos de tu cuenta." });
        return;
    }

    const profile = authDatabase.prepare(
        "SELECT phone, address FROM user_profiles WHERE user_id = ?"
    ).get(user.id);
    response.json({
        user: { name: user.name, email: user.email },
        profile: { phone: profile?.phone || "", address: profile?.address || "" }
    });
});

app.put("/api/profile", (request, response) => {
    const user = getAuthenticatedUser(request);
    if (!user) {
        response.status(401).json({ error: "Iniciá sesión para guardar los datos de tu cuenta." });
        return;
    }

    const phone = typeof request.body?.phone === "string" ? request.body.phone.trim() : "";
    const address = typeof request.body?.address === "string" ? request.body.address.trim() : "";
    if (phone.length > 30) {
        response.status(400).json({ error: "El teléfono no puede superar los 30 caracteres." });
        return;
    }
    if (address.length > 240) {
        response.status(400).json({ error: "La dirección no puede superar los 240 caracteres." });
        return;
    }

    authDatabase.prepare(`
        INSERT INTO user_profiles (user_id, phone, address, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            phone = excluded.phone,
            address = excluded.address,
            updated_at = excluded.updated_at
    `).run(user.id, phone, address, Date.now());
    response.json({ saved: true, profile: { phone, address } });
});

app.post("/api/logout", (request, response) => {
    const token = getSessionToken(request);
    if (token) authDatabase.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    clearSessionCookie(request, response);
    response.json({ authenticated: false });
});

app.post("/api/forgot-password", asyncRoute(async (request, response) => {
    if (!checkRateLimit(request, response, "forgot-password", 5, 15 * 60 * 1000)) return;

    const email = normalizeEmail(request.body?.email);
    if (!validEmail(email)) {
        response.status(400).json({ error: "Ingresá un correo electrónico válido." });
        return;
    }
    const mail = getEmailTransporter();
    const localRecovery = !mail && canUseLocalRecovery(request);
    if (!mail && !localRecovery) {
        response.status(503).json({
            error: "No se puede enviar el código porque el correo no está configurado. En producción, configurá SMTP en el archivo .env."
        });
        return;
    }

    const user = authDatabase.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (!user) {
        response.json({ message: "Si existe una cuenta con ese correo, recibirás un código de recuperación." });
        return;
    }

    const code = String(crypto.randomInt(100000, 1000000));
    const salt = crypto.randomBytes(16);
    const codeHash = await scrypt(code, salt, 32, PASSWORD_SCRYPT_OPTIONS);
    const expiresAt = Date.now() + RESET_CODE_DURATION_MS;
    authDatabase.prepare(`
        INSERT INTO password_resets (email, salt, code_hash, expires_at, attempts, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT(email) DO UPDATE SET
            salt = excluded.salt,
            code_hash = excluded.code_hash,
            expires_at = excluded.expires_at,
            attempts = 0,
            created_at = excluded.created_at
    `).run(email, salt.toString("hex"), codeHash.toString("hex"), expiresAt, Date.now());

    if (mail) {
        try {
            await sendRecoveryCode(email, code);
        } catch (error) {
            authDatabase.prepare("DELETE FROM password_resets WHERE email = ?").run(email);
            console.error("No se pudo enviar el código de recuperación:", error.message);
            response.status(503).json({
                error: "No se pudo enviar el correo. Verificá la configuración SMTP en .env e intentá nuevamente."
            });
            return;
        }
    }

    response.json({
        message: "Si existe una cuenta con ese correo, recibirás un código de recuperación.",
        ...(localRecovery ? { developmentCode: code } : {})
    });
}));

app.post("/api/reset-password", asyncRoute(async (request, response) => {
    if (!checkRateLimit(request, response, "reset-password", 10, 15 * 60 * 1000)) return;

    const email = normalizeEmail(request.body?.email);
    const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
    const password = request.body?.password;
    if (!validEmail(email) || !/^\d{6}$/.test(code) ||
        typeof password !== "string" || password.length < 8 || password.length > 128) {
        response.status(400).json({ error: "Revisá el correo, el código de 6 dígitos y la contraseña (8 a 128 caracteres)." });
        return;
    }

    const reset = authDatabase.prepare(
        "SELECT salt, code_hash, expires_at, attempts FROM password_resets WHERE email = ?"
    ).get(email);
    if (!reset || reset.expires_at <= Date.now() || reset.attempts >= 5) {
        authDatabase.prepare("DELETE FROM password_resets WHERE email = ?").run(email);
        response.status(400).json({ error: "El código venció o ya no es válido. Solicitá uno nuevo." });
        return;
    }

    const expectedHash = Buffer.from(reset.code_hash, "hex");
    const actualHash = await scrypt(code, Buffer.from(reset.salt, "hex"), expectedHash.length, PASSWORD_SCRYPT_OPTIONS);
    if (!crypto.timingSafeEqual(actualHash, expectedHash)) {
        authDatabase.prepare("UPDATE password_resets SET attempts = attempts + 1 WHERE email = ?").run(email);
        response.status(400).json({ error: "El código no es correcto. Revisalo e intentá nuevamente." });
        return;
    }

    const passwordHash = await hashPassword(password);
    authDatabase.exec("BEGIN IMMEDIATE");
    try {
        authDatabase.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(passwordHash, email);
        authDatabase.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)").run(email);
        authDatabase.prepare("DELETE FROM password_resets WHERE email = ?").run(email);
        authDatabase.exec("COMMIT");
    } catch (error) {
        authDatabase.exec("ROLLBACK");
        throw error;
    }
    response.json({ message: "La contraseña se cambió correctamente. Ya podés iniciar sesión." });
}));

app.post("/create_preference", async (request, response) => {
    const { items, email, delivery, address } = request.body ?? {};

    if (!Array.isArray(items) || items.length === 0 || items.length > 10) {
        response.status(400).json({ error: "El armado no contiene una cantidad válida de componentes." });
        return;
    }

    if (typeof email !== "string" ||
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        response.status(400).json({ error: "Ingresá un correo válido para continuar." });
        return;
    }

    if (delivery !== "shipping" && delivery !== "coordinate") {
        response.status(400).json({ error: "Seleccioná una modalidad de entrega válida." });
        return;
    }

    const normalizedAddress = typeof address === "string" ? address.trim() : "";
    if (delivery === "shipping" &&
        (normalizedAddress.length < 5 || normalizedAddress.length > 240)) {
        response.status(400).json({ error: "Ingresá una dirección de entrega de hasta 240 caracteres." });
        return;
    }

    const verifiedItems = [];
    for (const item of items) {
        if (!item || typeof item.name !== "string" ||
            !Number.isSafeInteger(item.price) ||
            !Number.isSafeInteger(item.quantity) ||
            item.quantity < 1 ||
            item.quantity > 99 ||
            !Array.isArray(CHECKOUT_CATALOG[item.name]) ||
            !CHECKOUT_CATALOG[item.name].includes(item.price)) {
            response.status(400).json({
                error: "Uno o más componentes no coinciden con el catálogo de precios publicado. Actualizá la página y volvé a intentarlo."
            });
            return;
        }

        verifiedItems.push({
            title: item.name,
            quantity: item.quantity,
            unit_price: item.price,
            currency_id: "ARS"
        });
    }

    if (!process.env.MP_ACCESS_TOKEN) {
        response.status(503).json({
            error: "Mercado Pago aún no está configurado. Agregá MP_ACCESS_TOKEN en el archivo .env del servidor."
        });
        return;
    }

    try {
        const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: verifiedItems,
                payer: { email: email.trim() },
                external_reference: `pcgamershop-${Date.now()}`
            }
        });

        if (typeof result.init_point !== "string") {
            console.error("Mercado Pago no devolvió init_point para una preferencia válida.");
            response.status(502).json({ error: "Mercado Pago no devolvió un enlace de pago." });
            return;
        }

        response.json({ init_point: result.init_point });
    } catch (error) {
        console.error("No se pudo crear la preferencia de Mercado Pago:", error.message);
        response.status(502).json({
            error: "Mercado Pago no pudo iniciar el pago. Verificá la configuración de la cuenta e intentá nuevamente."
        });
    }
});

app.use((error, _request, response, _next) => {
    if (error instanceof SyntaxError && "body" in error) {
        response.status(400).json({ error: "La solicitud no contiene JSON válido." });
        return;
    }

    console.error("Error en el servidor de la tienda:", error.message);
    response.status(500).json({ error: "Ocurrió un error interno. Intentá nuevamente más tarde." });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`PC Gamer Shop disponible en http://localhost:${PORT}`);
    });
}

module.exports = app;
