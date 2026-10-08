"""RS · Mis turnos — backend Flask + SQLite.

Autenticación multi-usuario con sesiones en servidor, passwords con bcrypt
y cifrado Fernet para las columnas sensibles (zona/notas).

Secretos SOLO por variables de entorno: SECRET_KEY, FERNET_KEY.
Nunca hardcodear secretos en el repo.
"""
import hashlib
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

import bcrypt
from cryptography.fernet import Fernet, InvalidToken
from flask import Flask, g, jsonify, make_response, redirect, request, send_file, send_from_directory

# ---------- Constantes del modelo ----------
MPG = 22               # rendimiento fijo usado en la fórmula del servidor
COMMISSION_RATE = 0.75  # bruto × 0.75  (comisión 25 %)
IRS_PER_MILE = 0.76    # solo referencia, NO se resta del neto
SESSION_DAYS = 7       # sesión normal
REMEMBER_DAYS = 30     # sesión con "Recordarme"
COOKIE_NAME = "rs_session"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "frontend"))
SCHEMA_PATH = os.path.join(BASE_DIR, "schema.sql")
# Raíz del staging / repo: ahí viven el board (index.html) y data/zones.json.
STAGING_ROOT = os.path.normpath(os.path.join(BASE_DIR, "..", ".."))
BOARD_PATH = os.environ.get("BOARD_PATH") or os.path.join(STAGING_ROOT, "index.html")
ZONES_PATH = os.environ.get("ZONES_PATH") or os.path.join(STAGING_ROOT, "data", "zones.json")


def utcnow():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


# ---------- Fórmula del neto (modelo v2, calculada en servidor) ----------
def parse_hm(t):
    h, m = str(t).split(":")
    return int(h) * 60 + int(m)


def costo_por_milla(gas_price, maintenance):
    """costo_por_milla = (precio_gas / 22) + mantenimiento_por_milla"""
    return gas_price / MPG + maintenance


def shift_metrics(bruto, millas_pax, millas_muertas, bono, gas_price, maintenance, inicio, fin):
    """net = (bruto × 0.75) − ((millas_pax + millas_muertas) × costo_por_milla) + (bono / horas)"""
    horas = (parse_hm(fin) - parse_hm(inicio)) / 60.0
    millas = millas_pax + millas_muertas
    cpm = costo_por_milla(gas_price, maintenance)
    neto = (bruto * COMMISSION_RATE) - (millas * cpm) + (bono / horas if horas > 0 else 0)
    return {
        "horas": round(horas, 4),
        "millas_totales": round(millas, 2),
        "costo_por_milla": round(cpm, 4),
        "neto": round(neto, 2),
        "neto_hora": round(neto / horas, 2) if horas > 0 else 0.0,
        "por_milla": round(neto / millas, 2) if millas > 0 else 0.0,
        "irs_referencia": round(millas * IRS_PER_MILE, 2),  # informativo, no resta del neto
    }


# ---------- App factory ----------
def create_app():
    secret_key = os.environ.get("SECRET_KEY")
    fernet_key = os.environ.get("FERNET_KEY")
    dev = os.environ.get("RS_DEV") == "1"

    if not secret_key:
        if dev:
            secret_key = secrets.token_hex(32)
            print("⚠️  RS_DEV=1: usando SECRET_KEY efímera (solo desarrollo).")
        else:
            raise RuntimeError("Falta la variable de entorno SECRET_KEY (ver backend/.env.example).")
    if not fernet_key:
        raise RuntimeError("Falta la variable de entorno FERNET_KEY (ver backend/.env.example).")

    app = Flask(__name__)
    app.config["SECRET_KEY"] = secret_key
    app.config["FERNET"] = Fernet(fernet_key.encode())
    app.config["DB_PATH"] = os.environ.get("DATABASE_PATH") or os.path.join(BASE_DIR, "data.db")
    app.config["COOKIE_SECURE"] = not dev  # en prod (HTTPS) la cookie viaja solo por TLS

    os.makedirs(os.path.dirname(os.path.abspath(app.config["DB_PATH"])), exist_ok=True)

    # ---------- DB ----------
    def get_db():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DB_PATH"])
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys = ON")
        return g.db

    @app.teardown_appcontext
    def close_db(exc=None):
        db = g.pop("db", None)
        if db is not None:
            db.close()

    def init_db():
        db = get_db()
        with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
            db.executescript(f.read())
        db.commit()

    with app.app_context():
        init_db()

    # ---------- Cifrado de zona/notas ----------
    def enc_zona(texto):
        if not texto:
            return ""
        return app.config["FERNET"].encrypt(texto.encode("utf-8")).decode("utf-8")

    def dec_zona(token):
        if not token:
            return ""
        try:
            return app.config["FERNET"].decrypt(token.encode("utf-8")).decode("utf-8")
        except InvalidToken:
            return ""  # token corrupto o FERNET_KEY distinta: no exponer nada

    # ---------- Passwords (bcrypt, jamás texto plano) ----------
    def hash_password(pw):
        return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt(12)).decode("utf-8")

    def check_password(pw, h):
        try:
            return bcrypt.checkpw(pw.encode("utf-8"), h.encode("utf-8"))
        except (ValueError, TypeError):
            return False

    # ---------- Sesiones ----------
    def create_session(user_id, days=SESSION_DAYS):
        db = get_db()
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        exp = iso(utcnow() + timedelta(days=days))
        db.execute("DELETE FROM sessions WHERE expires_at <= ?", (iso(utcnow()),))
        db.execute(
            "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)",
            (token_hash, user_id, exp, iso(utcnow())),
        )
        db.commit()
        return token

    def current_user():
        if hasattr(g, "user"):
            return g.user
        token = request.cookies.get(COOKIE_NAME)
        g.user = None
        if not token:
            return None
        th = hashlib.sha256(token.encode()).hexdigest()
        db = get_db()
        row = db.execute(
            """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1""",
            (th, iso(utcnow())),
        ).fetchone()
        if row:
            g.user = dict(row)
        return g.user

    def login_required(fn):
        from functools import wraps

        @wraps(fn)
        def wrapper(*a, **kw):
            if not current_user():
                return jsonify({"error": "no autenticado"}), 401
            return fn(*a, **kw)

        return wrapper

    def admin_required(fn):
        from functools import wraps

        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                return jsonify({"error": "no autenticado"}), 401
            if u["role"] != "admin":
                return jsonify({"error": "requiere rol admin"}), 403
            return fn(*a, **kw)

        return wrapper

    def set_session_cookie(resp, token, days=SESSION_DAYS):
        resp.set_cookie(
            COOKIE_NAME,
            token,
            httponly=True,
            secure=app.config["COOKIE_SECURE"],
            samesite="Lax",
            max_age=days * 86400,
            path="/",
        )

    # ---------- Validación de turnos ----------
    def validate_shift(data):
        errs = []
        for campo in ("fecha", "plataforma", "inicio", "fin"):
            if not data.get(campo):
                errs.append("Falta el campo: " + campo)
        if data.get("plataforma") not in ("uber", "lyft", "ambas"):
            errs.append("plataforma debe ser uber, lyft o ambas")
        try:
            if parse_hm(data.get("fin", "00:00")) <= parse_hm(data.get("inicio", "00:00")):
                errs.append("La hora de fin debe ser posterior a la de inicio.")
        except (ValueError, AttributeError):
            errs.append("Formato de hora inválido (usar HH:MM).")
        for campo in ("bruto", "millas_pax", "millas_muertas", "bono", "gas_price", "maintenance"):
            try:
                v = float(data.get(campo, 0))
                if v < 0:
                    errs.append(campo + " no puede ser negativo.")
            except (TypeError, ValueError):
                errs.append(campo + " debe ser un número.")
        return errs

    def shift_to_json(row):
        m = shift_metrics(
            row["bruto"], row["millas_pax"], row["millas_muertas"], row["bono"],
            row["gas_price"], row["maintenance"], row["inicio"], row["fin"],
        )
        out = {
            "id": row["id"],
            "fecha": row["fecha"],
            "plataforma": row["plataforma"],
            "inicio": row["inicio"],
            "fin": row["fin"],
            "bruto": row["bruto"],
            "millas_pax": row["millas_pax"],
            "millas_muertas": row["millas_muertas"],
            "bono": row["bono"],
            "gas_price": row["gas_price"],
            "maintenance": row["maintenance"],
            "zona": dec_zona(row["zona_enc"]),
        }
        out.update(m)
        return out

    # ================= API: auth =================
    @app.post("/api/login")
    def api_login():
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        # "Recordarme": sesión persistente de 30 días. La contraseña NUNCA se
        # guarda en el navegador: la persistencia la da la sesión en servidor.
        remember = bool(data.get("remember"))
        days = REMEMBER_DAYS if remember else SESSION_DAYS
        db = get_db()
        row = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if not row or row["active"] != 1 or not check_password(password, row["password_hash"]):
            return jsonify({"error": "usuario o contraseña inválidos"}), 401
        token = create_session(row["id"], days=days)
        resp = make_response(jsonify({"id": row["id"], "username": row["username"], "role": row["role"]}))
        set_session_cookie(resp, token, days=days)
        return resp

    @app.post("/api/logout")
    def api_logout():
        token = request.cookies.get(COOKIE_NAME)
        if token:
            th = hashlib.sha256(token.encode()).hexdigest()
            db = get_db()
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (th,))
            db.commit()
        resp = make_response(jsonify({"ok": True}))
        resp.delete_cookie(COOKIE_NAME, path="/")
        return resp

    @app.get("/api/me")
    def api_me():
        u = current_user()
        if not u:
            return jsonify({"error": "no autenticado"}), 401
        return jsonify({"id": u["id"], "username": u["username"], "role": u["role"]})

    # ================= API: turnos (solo propios) =================
    @app.get("/api/shifts")
    @login_required
    def api_shifts_list():
        u = current_user()
        db = get_db()
        rows = db.execute(
            "SELECT * FROM shifts WHERE user_id = ? ORDER BY fecha DESC, inicio DESC", (u["id"],)
        ).fetchall()
        return jsonify([shift_to_json(r) for r in rows])

    @app.post("/api/shifts")
    @login_required
    def api_shifts_create():
        u = current_user()
        data = request.get_json(silent=True) or {}
        errs = validate_shift(data)
        if errs:
            return jsonify({"error": "; ".join(errs)}), 400
        db = get_db()
        cur = db.execute(
            """INSERT INTO shifts
               (user_id, fecha, plataforma, inicio, fin, bruto, millas_pax, millas_muertas,
                bono, gas_price, maintenance, zona_enc, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                u["id"], data["fecha"], data["plataforma"], data["inicio"], data["fin"],
                float(data["bruto"]), float(data.get("millas_pax", 0)),
                float(data.get("millas_muertas", 0)), float(data.get("bono", 0)),
                float(data.get("gas_price", 0)), float(data.get("maintenance", 0.10)),
                enc_zona(str(data.get("zona") or "")), iso(utcnow()),
            ),
        )
        db.commit()
        row = db.execute("SELECT * FROM shifts WHERE id = ?", (cur.lastrowid,)).fetchone()
        return jsonify(shift_to_json(row)), 201

    def _own_shift_or_404(shift_id):
        u = current_user()
        db = get_db()
        row = db.execute(
            "SELECT * FROM shifts WHERE id = ? AND user_id = ?", (shift_id, u["id"])
        ).fetchone()
        return row

    @app.put("/api/shifts/<int:shift_id>")
    @login_required
    def api_shifts_update(shift_id):
        row = _own_shift_or_404(shift_id)
        if not row:
            return jsonify({"error": "turno no encontrado"}), 404
        data = request.get_json(silent=True) or {}
        errs = validate_shift(data)
        if errs:
            return jsonify({"error": "; ".join(errs)}), 400
        db = get_db()
        db.execute(
            """UPDATE shifts SET fecha=?, plataforma=?, inicio=?, fin=?, bruto=?,
               millas_pax=?, millas_muertas=?, bono=?, gas_price=?, maintenance=?, zona_enc=?
               WHERE id=?""",
            (
                data["fecha"], data["plataforma"], data["inicio"], data["fin"],
                float(data["bruto"]), float(data.get("millas_pax", 0)),
                float(data.get("millas_muertas", 0)), float(data.get("bono", 0)),
                float(data.get("gas_price", 0)), float(data.get("maintenance", 0.10)),
                enc_zona(str(data.get("zona") or "")), shift_id,
            ),
        )
        db.commit()
        row = db.execute("SELECT * FROM shifts WHERE id = ?", (shift_id,)).fetchone()
        return jsonify(shift_to_json(row))

    @app.delete("/api/shifts/<int:shift_id>")
    @login_required
    def api_shifts_delete(shift_id):
        row = _own_shift_or_404(shift_id)
        if not row:
            return jsonify({"error": "turno no encontrado"}), 404
        db = get_db()
        db.execute("DELETE FROM shifts WHERE id = ?", (shift_id,))
        db.commit()
        return jsonify({"ok": True})

    # ================= API: resumen (cálculos en servidor) =================
    @app.get("/api/summary")
    @login_required
    def api_summary():
        u = current_user()
        db = get_db()
        rows = db.execute("SELECT * FROM shifts WHERE user_id = ?", (u["id"],)).fetchall()
        total_bruto = total_neto = total_horas = 0.0
        mejor = None
        por_plat = {p: {"neto": 0.0, "horas": 0.0, "turnos": 0} for p in ("uber", "lyft", "ambas")}
        hoy = utcnow().date().isoformat()
        hace7 = (utcnow() - timedelta(days=6)).date().isoformat()
        d7 = {"turnos": 0, "neto": 0.0, "horas": 0.0}
        for r in rows:
            m = shift_metrics(
                r["bruto"], r["millas_pax"], r["millas_muertas"], r["bono"],
                r["gas_price"], r["maintenance"], r["inicio"], r["fin"],
            )
            total_bruto += r["bruto"]
            total_neto += m["neto"]
            total_horas += m["horas"]
            g = por_plat.get(r["plataforma"])
            if g:
                g["neto"] += m["neto"]
                g["horas"] += m["horas"]
                g["turnos"] += 1
            if mejor is None or m["neto_hora"] > mejor["neto_hora"]:
                mejor = {"id": r["id"], "fecha": r["fecha"], "plataforma": r["plataforma"],
                         "neto_hora": m["neto_hora"]}
            if hace7 <= r["fecha"] <= hoy:
                d7["turnos"] += 1
                d7["neto"] += m["neto"]
                d7["horas"] += m["horas"]
        for p, g in por_plat.items():
            g["neto"] = round(g["neto"], 2)
            g["horas"] = round(g["horas"], 2)
            g["neto_hora"] = round(g["neto"] / g["horas"], 2) if g["horas"] > 0 else None
        return jsonify({
            "total_bruto": round(total_bruto, 2),
            "total_neto": round(total_neto, 2),
            "total_horas": round(total_horas, 2),
            "neto_hora_prom": round(total_neto / total_horas, 2) if total_horas > 0 else 0.0,
            "mejor_turno": mejor,
            "ultimos_7_dias": {"turnos": d7["turnos"], "neto": round(d7["neto"], 2),
                               "horas": round(d7["horas"], 2)},
            "por_plataforma": por_plat,
            "formula": ("net = (bruto × 0.75) − ((millas_pax + millas_muertas) × costo_por_milla) "
                        "+ (bono ÷ horas); costo_por_milla = (precio_gas ÷ 22) + mantenimiento; "
                        "IRS $0.76/milla solo como referencia"),
        })

    # ================= API: admin =================
    @app.get("/api/admin/users")
    @admin_required
    def api_admin_list():
        db = get_db()
        rows = db.execute(
            "SELECT id, username, role, active, created_at FROM users ORDER BY id"
        ).fetchall()
        return jsonify([dict(r) for r in rows])

    def _generate_password(length=20):
        alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%&*"
        return "".join(secrets.choice(alphabet) for _ in range(length))

    @app.post("/api/admin/users")
    @admin_required
    def api_admin_create():
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or "").strip()
        role = data.get("role", "driver")
        password = data.get("password") or ""
        generated = False
        if not username or len(username) < 3:
            return jsonify({"error": "username mínimo 3 caracteres"}), 400
        if role not in ("admin", "driver"):
            return jsonify({"error": "role debe ser admin o driver"}), 400
        if not password:
            password = _generate_password()
            generated = True
        elif len(password) < 8:
            return jsonify({"error": "la contraseña debe tener al menos 8 caracteres"}), 400
        db = get_db()
        try:
            cur = db.execute(
                "INSERT INTO users (username, password_hash, role, active, created_at) VALUES (?,?,?,?,?)",
                (username, hash_password(password), role, 1, iso(utcnow())),
            )
            db.commit()
        except sqlite3.IntegrityError:
            return jsonify({"error": "ese username ya existe"}), 409
        out = {"id": cur.lastrowid, "username": username, "role": role}
        if generated:
            # Se entrega UNA sola vez: el hash bcrypt es lo único que se guarda.
            out["password_once"] = password
        return jsonify(out), 201

    @app.post("/api/admin/users/<int:user_id>/deactivate")
    @admin_required
    def api_admin_deactivate(user_id):
        me = current_user()
        if user_id == me["id"]:
            return jsonify({"error": "no podés desactivar tu propia cuenta"}), 400
        db = get_db()
        row = db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            return jsonify({"error": "usuario no encontrado"}), 404
        db.execute("UPDATE users SET active = 0 WHERE id = ?", (user_id,))
        db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
        db.commit()
        return jsonify({"ok": True})

    # ================= Vistas (todo detrás del login) =================
    # El Demand Board (index.html del diseño) NO se modifica jamás: se sirve
    # tal cual en /board. Como la página está en /board (sin slash final),
    # su fetch relativo a 'data/zones.json' resuelve a /data/zones.json.
    LOGIN_HTML = """<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RS · Ingresar</title>
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{background:#0d1012;color:#eef2f3;font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#151a1d;border:1px solid #283036;border-radius:18px;padding:28px;width:100%;max-width:380px}
h1{margin:0 0 4px;font-size:22px}.sub{color:#a5b1b7;margin:0 0 18px;font-size:14px}
input[type=text],input[type=password]{width:100%;background:#1c2226;border:1px solid #283036;color:#eef2f3;
border-radius:12px;padding:12px;margin:0 0 10px;font-size:16px}
.rem{display:flex;align-items:center;gap:8px;color:#a5b1b7;font-size:14px;margin:2px 0 14px;cursor:pointer}
.rem input{width:18px;height:18px;accent-color:#22c55e}
button{width:100%;background:#22c55e;color:#06240f;border:0;border-radius:12px;padding:13px;
font-size:16px;font-weight:700;cursor:pointer}
#e{color:#f26b5b;min-height:22px;margin-top:10px;font-size:14px}
</style></head>
<body><main class="card">
<h1>RS · Mis turnos</h1>
<p class="sub">Ingresá para ver el Demand Board y tus turnos.</p>
<form id="f">
<input id="u" type="text" autocomplete="username" placeholder="Usuario" required>
<input id="p" type="password" autocomplete="current-password" placeholder="Contraseña" required>
<label class="rem"><input type="checkbox" id="r" checked> Recordarme en este dispositivo</label>
<button type="submit">Entrar</button>
<div id="e"></div>
</form></main>
<script>
document.getElementById('f').addEventListener('submit', async function(ev){
  ev.preventDefault();
  var box = document.getElementById('e'); box.textContent = '';
  try{
    var res = await fetch('/api/login', {method:'POST', credentials:'include',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username: document.getElementById('u').value.trim(),
        password: document.getElementById('p').value,
        remember: document.getElementById('r').checked})});
    if(res.ok){ document.getElementById('p').value=''; location.href='/board'; return; }
    var d = await res.json().catch(function(){return {};});
    box.textContent = '⚠️ ' + (d.error || 'No se pudo ingresar');
  }catch(err){ box.textContent = '⚠️ Error de red'; }
});
</script></body></html>"""

    @app.get("/")
    def login_view():
        if current_user():
            return redirect("/board")
        return LOGIN_HTML

    @app.get("/board")
    @login_required
    def board_view():
        # index.html del diseño, intacto. 404s de manifest/icons que no existen: se ignoran.
        return send_file(BOARD_PATH, mimetype="text/html")

    @app.get("/data/zones.json")
    @login_required
    def zones_json():
        return send_file(ZONES_PATH, mimetype="application/json")

    @app.get("/turnos")
    def turnos_redirect():
        return redirect("/turnos/")

    @app.get("/turnos/")
    @login_required
    def turnos_index():
        return send_from_directory(FRONTEND_DIR, "index.html")

    @app.get("/turnos/<path:path>")
    @login_required
    def turnos_files(path):
        return send_from_directory(FRONTEND_DIR, path)

    @app.after_request
    def add_headers(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    # Exponer helpers para el CLI
    app.hash_password = hash_password
    app.get_db = get_db
    return app


def get_app():
    return create_app()
