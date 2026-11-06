# Vista previa en Railway

## Crear el repositorio gratis sin usar la terminal

1. En [GitHub](https://github.com/new), creá un repositorio privado llamado
   `pc-gamer-shop`. No marques las opciones para agregar README, `.gitignore` o licencia.
2. Instalá [GitHub Desktop](https://desktop.github.com/) e iniciá sesión.
3. En GitHub Desktop, cloná el repositorio recién creado.
4. Extraé el contenido de `pc-gamer-shop-preview.zip` dentro de la carpeta clonada.
   Copiá los archivos del proyecto, no el ZIP. No agregues un archivo `.env`.
5. En GitHub Desktop, escribí un resumen, elegí **Commit to main** y luego
   **Push origin**.

El `.env.example` incluido solo tiene marcadores de ejemplo; no contiene credenciales.
No compartas contraseñas ni tokens en el chat.

## Preparar el servicio

1. Subí el proyecto a un repositorio **privado** y conectalo como servicio en Railway.
2. En la configuración del servicio, agregá un volumen persistente con punto de montaje `/data`.
3. En **Variables**, configurá:

   - `NODE_ENV=production`
   - `AUTH_DB_PATH=/data/accounts.sqlite`

Railway asigna `PORT` automáticamente. El servidor confía en el proxy HTTPS de Railway
para marcar como seguras las cookies de sesión.

No subas `.env`, `data/`, credenciales ni la base de cuentas local. Ya están excluidos
por `.gitignore`. No copies los valores de ejemplo como secretos reales.

## Costo y límites del plan gratuito

GitHub ofrece repositorios privados en su plan gratuito, así que no hace falta pagar
para guardar el código. Railway publica un plan Free de $0 con $1 mensual de crédito
para recursos y hasta 0,5 GB de volumen; ese crédito puede no alcanzar para mantener
el servicio activo todo el mes. Es una vista previa, no un hosting con disponibilidad
garantizada. Revisá el uso y los límites vigentes antes de desplegar; no agregues una
forma de pago ni cambies a un plan pago si no querés asumir cargos.

Precios oficiales: [Railway](https://railway.com/pricing) y
[GitHub](https://github.com/pricing). Los precios y límites pueden cambiar.

## Alcance de la vista previa

- El catálogo, las imágenes, el registro, el inicio de sesión y los perfiles estarán
  disponibles. La base local no se copia al despliegue; cada usuario deberá registrarse
  de nuevo.
- Los pagos con Mercado Pago quedan desactivados hasta configurar `MP_ACCESS_TOKEN`
  como variable secreta del servicio. No agregues un valor de ejemplo.
- La recuperación de contraseña por correo requiere `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_APP_PASSWORD` y `SMTP_FROM`, configurados como variables secretas.
  Sin SMTP, no estará disponible en producción.
- Las transferencias no se procesan ni confirman automáticamente: el sitio abre un
  correo para solicitar los datos y la compra solo se confirma manualmente.

## Despliegue

Railway lee `railway.json` para ejecutar `npm start` y comprobar el servicio en
`/healthz`. El proyecto requiere Node.js 22.13 o superior. `npm start` ejecuta primero
`sync-products.js`, que valida los recursos locales y genera el catálogo auxiliar.

El servicio crea las tablas de cuenta en la base indicada por `AUTH_DB_PATH`. Tras
desplegar, verificá que `/healthz` responda `{"status":"ok"}` y probá crear una cuenta
nueva en el dominio asignado por Railway.

## Ejecutar localmente

En Windows, desde la carpeta del proyecto, ejecutá `npm.cmd start` y abrí
`http://localhost:3000/`.
