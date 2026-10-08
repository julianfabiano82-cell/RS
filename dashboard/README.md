# RS · Mis turnos — Panel personal de rideshare (full-stack)

Dashboard personal de turnos de rideshare (Uber / Lyft) con backend multi-usuario:
login, turnos por usuario, métricas calculadas en el servidor y datos sensibles cifrados.

## Estructura

```
rs-dashboard/
├── backend/
│   ├── __init__.py        # App Flask: auth, sesiones, API, cifrado
│   ├── __main__.py        # CLI: `python -m backend run` / `create-user`
│   ├── schema.sql         # Tablas: users, sessions, shifts
│   ├── requirements.txt   # Flask, bcrypt, cryptography
│   ├── .env.example       # Plantilla de variables de entorno (sin secretos reales)
│   └── README.md          # Detalle del backend y la API
├── frontend/
│   ├── index.html         # Login + vistas del dashboard
│   ├── app.js             # Lógica (fetch a /api/*, sin localStorage de turnos)
│   └── styles.css         # Tema oscuro, mobile-first
└── README.md              # Este archivo
```

## Puesta en marcha rápida

```bash
pip install -r backend/requirements.txt
export SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
export FERNET_KEY=$(python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())")
export RS_DEV=1   # solo desarrollo local; en producción NO definir

python -m backend create-user --username admin --role admin
python -m backend run --port 5000
# Abrir http://127.0.0.1:5000 → login → dashboard
```

El admin crea los demás usuarios desde el panel (sección ⚙️ Datos, solo visible
para admin) o con `POST /api/admin/users`. Si no se indica contraseña, el servidor
genera una fuerte y la muestra **una sola vez**.

## Qué hace el dashboard

- **Resumen**: total bruto, total neto, horas, neto/hora promedio, mejor turno,
  comparativa Uber vs Lyft y últimos 7 días — calculados en el servidor (`/api/summary`).
- **Registrar**: formulario con validación y vista previa del cálculo en vivo.
- **Historial**: tabla ordenable por fecha, editar/borrar (solo turnos propios).
- **Gráficos**: neto/hora por día (30 días), por plataforma y neto por hora de inicio (SVG inline).
- **Datos**: exportar/importar CSV, ajustes de precio de gasolina y mantenimiento,
  y (admin) gestión de usuarios.

## Fórmula del neto (modelo v2, servidor)

```
neto = (bruto × 0.75) − ((millas_pax + millas_muertas) × costo_por_milla) + (bono ÷ horas)
costo_por_milla = (precio_gasolina ÷ 22) + mantenimiento_por_milla
```

Cada número calculado muestra su fórmula en un tooltip (ⓘ). La deducción del IRS
($0.76/milla) se muestra como referencia y **no** se resta del neto.

## Notas de seguridad

- Passwords con **bcrypt** (nunca texto plano); notas/zona cifradas con **Fernet**;
  sesiones en servidor con cookie `HttpOnly + Secure + SameSite=Lax` (7 días).
- `SECRET_KEY` y `FERNET_KEY` **solo** por variables de entorno; nada de secretos en el repo.
- En producción el deploy **debe** ser HTTPS (la cookie y las credenciales no pueden
  viajar en claro). Ver `backend/README.md` para el detalle completo.
