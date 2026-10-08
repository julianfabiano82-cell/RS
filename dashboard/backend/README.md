# RS backend — Flask + SQLite

API con autenticación multi-usuario para el dashboard de turnos de rideshare.

## Requisitos

- Python 3.10+
- `pip install -r requirements.txt`

## Configuración (variables de entorno — nunca en el repo)

| Variable        | Obligatoria | Descripción |
|----------------|-------------|-------------|
| `SECRET_KEY`    | sí          | Clave de Flask. Generar: `python -c "import secrets; print(secrets.token_hex(32))"` |
| `FERNET_KEY`    | sí          | Clave para cifrar notas/zona. Generar: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `DATABASE_PATH` | no          | Ruta del SQLite (default: `backend/data.db`) |
| `BOARD_PATH`    | no          | Ruta del index.html del Demand Board (default: `<staging>/index.html`; ese archivo NO se edita) |
| `ZONES_PATH`    | no          | Ruta del `data/zones.json` diario (default: `<staging>/data/zones.json`) |
| `RS_DEV`        | no          | `1` solo en desarrollo local (permite cookie sin HTTPS). En producción debe ser `0` o no definirse. |

⚠️ Si cambiás `FERNET_KEY`, las notas cifradas con la clave anterior quedan ilegibles.
Copiá `backend/.env.example` a `.env` como referencia (el `.gitignore` excluye `.env` y `data.db`).

## Puesta en marcha

```bash
cd rs-dashboard
pip install -r backend/requirements.txt
export SECRET_KEY=... FERNET_KEY=...

# 1) Crear el primer admin (el registro es SOLO admin; sin admin no hay usuarios)
python -m backend create-user --username admin --role admin
#    (pide la contraseña por teclado; o --password ... solo en entornos controlados)

# 2) Levantar el servidor
python -m backend run --port 5000
# Abrir http://127.0.0.1:5000 → login → /board (Demand Board)
# /turnos → dashboard de turnos con métricas
```

Todo va detrás del login: `/` muestra la pantalla de ingreso, `/board` sirve el
Demand Board (index.html del diseño, intacto), `/turnos` el dashboard de turnos y
`/data/zones.json` los datos del día (solo autenticado). El fetch relativo de la
página (`data/zones.json`) resuelve a `/data/zones.json` porque el board se sirve
en `/board` (sin slash final). No hay Cloudflare: el deploy es servidor propio
con HTTPS (ver Seguridad).

En producción, servir detrás de un reverse proxy con **HTTPS** y usar un WSGI
como gunicorn: `gunicorn -w 4 'backend:create_app()'`.

## Datos diarios del Demand Board

El `data/zones.json` lo genera el agente de datos cada mañana escribiendo el
archivo en el servidor (ruta `ZONES_PATH`): pronóstico de 24 h construido desde
las carpetas de Ridesharing en Drive. El formato está especificado en
`AGENT_GUIDE.md` (ese archivo es la especificación y no se modifica). Ya no se
usa commit+push para los datos: el backend sirve el archivo que el agente
actualiza en disco.

## API (JSON)

Autenticación por cookie de sesión `rs_session` (HttpOnly + Secure + SameSite=Lax,
7 días de expiración, sesión guardada en servidor).

- `POST /api/login` `{username, password, remember?}` → `{id, username, role}` + cookie.
  Con `remember: true` la sesión dura 30 días (ver "Recordarme"); sin él, 7 días.
- `POST /api/logout` → cierra la sesión
- `GET /api/me` → `{id, username, role}` o 401
- `GET /api/shifts` → turnos **propios** (cada uno con métricas calculadas)
- `POST /api/shifts` → crea un turno propio (201)
- `PUT /api/shifts/<id>` → actualiza un turno propio (404 si no es tuyo)
- `DELETE /api/shifts/<id>` → borra un turno propio
- `GET /api/summary` → totales, neto/hora y comparativa, calculados en servidor
- `GET /api/admin/users` → lista usuarios (solo admin, sin hashes)
- `POST /api/admin/users` `{username, role, password?}` → crea usuario (solo admin);
  si no se pasa `password`, se genera una contraseña fuerte y se devuelve **una sola vez**
  en `password_once` (solo se guarda su hash bcrypt)
- `POST /api/admin/users/<id>/deactivate` → desactiva usuario y cierra sus sesiones (solo admin)

Campos de turno: `fecha, plataforma (uber|lyft|ambas), inicio, fin, bruto, millas_pax,
millas_muertas, bono, gas_price, maintenance, zona`.

## Fórmula del neto (servidor)

```
net = (bruto × 0.75) − ((millas_pax + millas_muertas) × costo_por_milla) + (bono ÷ horas)
costo_por_milla = (precio_gas ÷ 22) + mantenimiento_por_milla
```

IRS $0.76/milla: solo como referencia (`irs_referencia`), no se resta del neto.

## Seguridad

- **Passwords**: hash bcrypt (coste 12), jamás texto plano. Verificable en la DB:
  `password_hash` empieza con `$2b$`.
- **Notas/zona**: cifradas con Fernet (AES-128-CBC + HMAC) en la columna `zona_enc`;
  la `FERNET_KEY` vive solo en variable de entorno.
- **Sesiones**: token aleatorio de 32 bytes; en la DB se guarda su SHA-256 (no el token);
  cookie `HttpOnly` + `Secure` + `SameSite=Lax`. Expira en 7 días, o 30 días con "Recordarme".
- **Recordarme ("save user and pass")**: el checkbox del login pide una sesión persistente
  de 30 días (cookie con `max-age` de 30 días + expiración en servidor a 30 días).
  La contraseña **nunca** se almacena en el navegador — ni en localStorage, ni en cookies,
  ni en ningún lado: guardar credenciales en el cliente las expone a cualquier script
  (XSS) o a quien abra el navegador. La sesión persistente del servidor logra exactamente
  lo mismo (no volver a escribir usuario y contraseña) sin exponer ningún secreto.
- **Transporte**: en producción el deploy DEBE ser HTTPS — con HTTP la cookie
  (incluso con `Secure`) y las credenciales viajarían en claro. `RS_DEV=1` desactiva
  el flag `Secure` solo para desarrollo local.
- **Aislamiento**: cada driver ve y toca solo sus propios turnos (filtro `user_id`
  en todas las queries); el admin no ve turnos ajenos.
- Sin secretos hardcodeados: el código falla al arrancar si faltan `SECRET_KEY`/`FERNET_KEY`.
