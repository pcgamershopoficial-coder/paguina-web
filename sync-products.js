const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = __dirname;
const catalogPath = path.join(root, "products.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error("products.json debe contener una lista de productos.");
}

function extractArray(source, declaration) {
    const declarationIndex = source.indexOf(declaration);
    if (declarationIndex < 0) {
        throw new Error(`No se encontró ${declaration} en index.html.`);
    }

    const start = declarationIndex + declaration.length - 1;
    let depth = 0;
    let quote = "";
    let escaped = false;
    let end = -1;

    for (let index = start; index < source.length; index += 1) {
        const character = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === quote) quote = "";
            continue;
        }

        if (character === "\"" || character === "'" || character === "`") {
            quote = character;
        } else if (character === "[") {
            depth += 1;
        } else if (character === "]") {
            depth -= 1;
            if (depth === 0) {
                end = index + 1;
                break;
            }
        }
    }

    if (end < 0) {
        throw new Error(`No se pudo leer ${declaration} en index.html.`);
    }

    return vm.runInNewContext(`(${source.slice(start, end)})`, {}, { timeout: 1000 });
}

function modelSlug(model) {
    return model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeXml(value) {
    return value.replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&apos;"
    })[character]);
}

function wrapModel(model, maxLength = 24) {
    const words = model.split(/\s+/);
    const lines = [];
    let line = "";

    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (candidate.length > maxLength && line) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line);
    return lines;
}

function createProcessorIllustration(brand, model) {
    const accent = brand === "AMD" ? "#ed6a16" : "#38a9ff";
    const lines = wrapModel(model);
    const modelText = lines.map((line, index) =>
        `<text x="320" y="${239 + index * 36}" text-anchor="middle" class="model">${escapeXml(line)}</text>`
    ).join("\n");
    const pins = Array.from({ length: 10 }, (_, index) => {
        const offset = 135 + index * 40;
        return [
            `<path d="M${offset} 71v-28M${offset} 409v28" />`,
            `<path d="M101 ${offset + 35}h-28M539 ${offset + 35}h28" />`
        ].join("");
    }).join("");

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" role="img" aria-labelledby="title description">
<title id="title">${escapeXml(model)}</title>
<desc id="description">Ilustracion original de un procesador ${escapeXml(brand)}. No es una fotografia del producto.</desc>
<defs>
    <linearGradient id="background" x2="1" y2="1"><stop stop-color="#101d32"/><stop offset="1" stop-color="#080d17"/></linearGradient>
    <linearGradient id="chip" x2="1" y2="1"><stop stop-color="#263850"/><stop offset="1" stop-color="#111b2b"/></linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="14" stdDeviation="13" flood-color="#000" flood-opacity=".5"/></filter>
</defs>
<rect width="640" height="480" rx="22" fill="url(#background)"/>
<path d="M0 371h640M0 390h640" stroke="${accent}" stroke-opacity=".16"/>
<g fill="none" stroke="${accent}" stroke-opacity=".72" stroke-width="5" stroke-linecap="round">${pins}</g>
<g filter="url(#shadow)">
    <rect x="101" y="71" width="438" height="338" rx="27" fill="#0b111b" stroke="${accent}" stroke-width="3"/>
    <rect x="133" y="103" width="374" height="274" rx="19" fill="url(#chip)" stroke="#486078" stroke-width="2"/>
    <path d="M153 123h334v234H153z" fill="none" stroke="#71839a" stroke-opacity=".35"/>
    <path d="M172 142h296v196H172z" fill="#101a29" stroke="${accent}" stroke-opacity=".58" stroke-width="2"/>
</g>
<text x="320" y="183" text-anchor="middle" class="brand">${escapeXml(brand)} · PC GAMER SHOP</text>
${modelText}
<text x="320" y="438" text-anchor="middle" class="caption">ILUSTRACION ORIGINAL · NO ES FOTO REAL</text>
<style>
    text{font-family:Segoe UI,Arial,sans-serif}
    .brand{fill:${accent};font-size:15px;font-weight:700;letter-spacing:2px}
    .model{fill:#f4f7fb;font-size:${lines.length > 3 ? 19 : 23}px;font-weight:700}
    .caption{fill:#9badc2;font-size:11px;letter-spacing:1.5px}
</style>
</svg>\n`;
}

const processorCatalog = extractArray(html, "const processorCatalog = [");
if (!Array.isArray(processorCatalog)) {
    throw new Error("El catálogo de procesadores no tiene un formato válido.");
}

const processorImageDirectory = path.join(root, "assets", "products", "processors");
fs.mkdirSync(processorImageDirectory, { recursive: true });
const processorIllustrations = new Map();
for (const family of processorCatalog) {
    if (!family || !["AMD", "Intel"].includes(family.brand) || !Array.isArray(family.models)) {
        throw new Error("Hay una familia de procesadores inválida en index.html.");
    }

    for (const model of family.models) {
        if (typeof model !== "string" || !model.trim()) {
            throw new Error("Hay un modelo de procesador sin nombre.");
        }

        const alreadyHasProductImage = catalog.some(product =>
            product.category === "Procesadores" &&
            (product.name === model || product.name.startsWith(`${model} `))
        );
        if (alreadyHasProductImage) continue;

        const imagePath = `assets/products/processors/${modelSlug(model)}.svg`;
        const previousModel = processorIllustrations.get(imagePath);
        if (previousModel && previousModel !== model) {
            throw new Error(`Los modelos ${previousModel} y ${model} generan el mismo nombre de imagen.`);
        }
        processorIllustrations.set(imagePath, model);
        fs.writeFileSync(
            path.join(root, imagePath),
            createProcessorIllustration(family.brand, model),
            "utf8"
        );
    }
}

for (const product of catalog) {
    if (!product || typeof product.name !== "string" || typeof product.image !== "string") {
        throw new Error("Cada producto debe tener un nombre y una imagen válidos.");
    }

    if (product.image.startsWith("assets/") &&
        !fs.existsSync(path.join(root, product.image))) {
        throw new Error(`No se encontró la imagen de ${product.name}: ${product.image}`);
    }
}

const browserCatalog = `window.PCGS_PRODUCTS = ${JSON.stringify(catalog, null, 4)};\n`;
fs.writeFileSync(path.join(root, "products.js"), browserCatalog, "utf8");
console.log(`Catálogo sincronizado para el navegador: ${catalog.length} productos.`);
console.log(`Ilustraciones originales generadas: ${processorIllustrations.size} procesadores.`);
