"""
GD4 Assistant — Relay Server v1.5 (UNIFIÉ avec le serveur du plugin)

MÊME protocole que gd4-assistance-plugin/server.py — quel que soit le relais
lancé, l'app et le plugin Godot se comportent exactement pareil :

  - WS /ws/godot : le plugin s'authentifie {"type":"auth_handshake","pairing_code":...}
  - WS /ws/ui    : l'app web (tuyau vers Godot)
  - GET  /health        → {"pin", "owner", "godot_connected"} (l'app adopte ce PIN)
  - GET  /pairing-code  → {"pin", "owner"}
  - POST /pairing-code  → impose un code  {pin|code|pairing_code, email}
  - POST /regenerate-pin→ alias (sans 'pin' → code aléatoire GD4-XXXX)
  - Changement de code  → poussé au plugin {"type":"pairing_update","pin":...}

PIN au démarrage : aléatoire GD4-XXXX (surchargeable via env GD4_PIN).
Port 9091 (aligné avec l'app web).
"""

import asyncio
import json
import os
import random
import sys
import time
from urllib.parse import urlparse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="GD4 Relay v1.5")

# --- Code d'appairage : format GD4-XXXX IDENTIQUE partout (app + plugin) -----
CODE_PREFIX = "GD4-"
CODE_LENGTH = 4
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # sans 0/O/1/I : lisibilité


def generate_pin() -> str:
    return CODE_PREFIX + "".join(random.choices(CODE_ALPHABET, k=CODE_LENGTH))


PAIRING_CODE = os.environ.get("GD4_PIN") or generate_pin()
CODE_OWNER = {PAIRING_CODE: "local"}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

ALLOWED_ORIGINS = {"127.0.0.1", "localhost"}
ALLOWED_ORIGINS.update(
    h.strip() for h in os.environ.get("GD4_ALLOWED_ORIGINS", "").split(",") if h.strip()
)


def _origin_allowed(websocket: WebSocket) -> bool:
    origin = websocket.headers.get("origin", "")
    if not origin:
        return True
    return urlparse(origin).hostname in ALLOWED_ORIGINS


def _extract_code(body: dict) -> str:
    return str(body.get("pin") or body.get("code") or body.get("pairing_code") or "").strip()


def _ensure_request_id(data: dict) -> None:
    """Garantit un request_id unique pour la déduplication côté app web
    (utile quand plusieurs onglets du cerveau sont ouverts)."""
    if not str(data.get("request_id") or ""):
        data["request_id"] = "srv-%d-%d" % (time.monotonic_ns(), random.getrandbits(16))


async def _apply_new_code(new_code: str, email: str, source: str) -> None:
    global PAIRING_CODE
    PAIRING_CODE = new_code
    CODE_OWNER[PAIRING_CODE] = email
    print(f"🔑 Code mis à jour ({source}) : {PAIRING_CODE}")
    if manager.godot_ws:
        try:
            await manager.godot_ws.send_text(json.dumps(
                {"type": "pairing_update", "pin": PAIRING_CODE}))
            await asyncio.sleep(0.5)
        except Exception:
            pass
        await manager.godot_ws.close()
    await manager.notify_ui()


class ConnectionManager:
    def __init__(self):
        self.godot_ws: WebSocket | None = None
        self.ui_sockets: list = []
        self.plugin_email: str = "local"
        self.project_context: dict = {}
        self.recent_request_ids: dict[str, float] = {}

    def remember_request_id(self, request_id: str) -> bool:
        if not request_id:
            return False
        now = time.monotonic()
        self.recent_request_ids = {
            key: value for key, value in self.recent_request_ids.items() if value > now - 300
        }
        if request_id in self.recent_request_ids:
            return False
        self.recent_request_ids[request_id] = now
        return True

    async def broadcast_ui(self, payload: dict | None = None, raw: str | None = None):
        text = raw if raw is not None else json.dumps(payload or {})
        dead = []
        # Le dernier onglet ouvert est le cerveau actif; les anciens onglets
        # peuvent être restés enregistrés après une navigation ou une veille.
        for ws in reversed(list(self.ui_sockets)):
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            if ws in self.ui_sockets:
                self.ui_sockets.remove(ws)

    async def notify_ui(self):
        await self.broadcast_ui({
            "type": "status",
            "pin": PAIRING_CODE,
            "godot_connected": self.godot_ws is not None
        })

    def active_ui_socket(self) -> WebSocket | None:
        """Retourne le cerveau actif : le dernier onglet UI ouvert."""
        if not self.ui_sockets:
            return None
        return self.ui_sockets[-1]

    async def send_to_brain(self, raw: str) -> None:
        """Envoie la demande uniquement au cerveau actif (dernier onglet UI).
        Les écrans de console/status restent visibles mais ne déclenchent pas
        de double traitement IA."""
        target = self.active_ui_socket()
        if target is None:
            return
        try:
            await target.send_text(raw)
        except Exception:
            if target in self.ui_sockets:
                self.ui_sockets.remove(target)


manager = ConnectionManager()


@app.get("/health")
async def health():
    # Le PIN est inclus → l'app peut toujours adopter le code réel du relais.
    return {
        "status": "ok",
        "pin": PAIRING_CODE,
        "owner": CODE_OWNER.get(PAIRING_CODE, "local"),
        "godot_connected": manager.godot_ws is not None,
    }


@app.get("/pairing-code")
async def get_pairing_code(request: Request):
    origin = request.headers.get("origin", "")
    if origin and urlparse(origin).hostname not in ALLOWED_ORIGINS:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    return {"pin": PAIRING_CODE, "owner": CODE_OWNER.get(PAIRING_CODE, "local")}


@app.post("/pairing-code")
async def set_pairing_code(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    new_code = _extract_code(body)
    email = body.get("email", "local")
    print(f"📬 POST /pairing-code reçu : code={new_code!r}")
    if not new_code:
        return JSONResponse({"error": "missing 'pin' field"}, status_code=400)
    await _apply_new_code(new_code, email, "POST")
    return {"ok": True, "pin": PAIRING_CODE, "owner": email}


@app.post("/regenerate-pin")
async def regenerate_pin(request: Request):
    """Alias de POST /pairing-code (compatibilité app). Sans 'pin' → code aléatoire GD4-XXXX."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    new_code = _extract_code(body) or generate_pin()
    email = body.get("email", "local")
    await _apply_new_code(new_code, email, "POST/regenerate-pin")
    return {"ok": True, "pin": PAIRING_CODE, "owner": email, "changed": True}


# ---------- WEBSOCKET PLUGIN GODOT : tuyau vers l'app ----------
@app.websocket("/ws/godot")
async def websocket_godot(websocket: WebSocket):
    if not _origin_allowed(websocket):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        raw_msg = await websocket.receive_text()
        data = json.loads(raw_msg)

        code = str(data.get("pairing_code", "")).strip()
        if data.get("type") == "auth_handshake" and code == PAIRING_CODE:
            manager.godot_ws = websocket
            manager.plugin_email = CODE_OWNER.get(code, "local")
            print(f"🟢 Plugin Godot connecté (compte : {manager.plugin_email})")
            await manager.notify_ui()

            while True:
                msg = await websocket.receive_text()
                data = json.loads(msg)
                if data.get("type") == "context_response":
                    manager.project_context = data
                elif data.get("type") == "plugin_chat" and manager.project_context.get("project_files"):
                    data["project_files"] = manager.project_context["project_files"]
                if data.get("type") in ("plugin_chat", "ui_chat"):
                    _ensure_request_id(data)
                    msg = json.dumps(data, ensure_ascii=False)
                    await manager.send_to_brain(msg)
                else:
                    # plugin_new_chat du dock : tuyau vers le cerveau (l'app web
                    # ouvre une vraie conversation liée au plugin + renvoie
                    # plugin_new_chat_ok affiché par le dock).
                    await manager.broadcast_ui(raw=msg)
        else:
            await websocket.send_text(json.dumps({"type": "auth_failed"}))
            await websocket.send_text(json.dumps(
                {"type": "pairing_update", "pin": PAIRING_CODE}))
            await asyncio.sleep(0.5)
            print("🔴 Code invalide :", code, "→ envoyé le bon code")
            await websocket.close()
            return

    except WebSocketDisconnect:
        print("🔴 Godot déconnecté")
    finally:
        if manager.godot_ws is websocket:
            manager.godot_ws = None
            await manager.notify_ui()


# ---------- WEBSOCKET APP / CONSOLE : tuyau vers Godot ----------
@app.websocket("/ws/ui")
async def websocket_ui(websocket: WebSocket):
    if not _origin_allowed(websocket):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    manager.ui_sockets.append(websocket)
    await manager.notify_ui()

    try:
        while True:
            msg = await websocket.receive_text()
            try:
                d = json.loads(msg)
            except Exception:
                d = None

            # L'app pousse un nouveau code d'appairage
            if isinstance(d, dict) and d.get("type") in (
                "pairing_update", "set_pairing_code", "pairing_code", "set_code"):
                new_code = _extract_code(d)
                if new_code:
                    await _apply_new_code(new_code, d.get("email", "local"), "WS")
                continue

            # Réponses de chat : la PREMIÈRE occurrence d'un request_id part vers
            # Godot ET est diffusée aux écrans UI (console + dock). Les suivantes
            # (même id, ex. plusieurs onglets du cerveau) sont ignorées : on ne
            # réapplique jamais deux fois les mêmes actions dans la scène.
            if isinstance(d, dict) and d.get("type") == "ai_result":
                request_id = str(d.get("request_id") or "")
                if request_id and not manager.remember_request_id(request_id):
                    print(f"[DEDUPLICATED] ai_result déjà traité: {request_id}")
                    continue
                # TOUJOURS envoyer la réponse au plugin Godot
                if manager.godot_ws:
                    try:
                        await manager.godot_ws.send_text(msg)
                        print(f"[SEND→GODOT] ai_result envoyé au plugin: {request_id}")
                    except Exception as e:
                        print(f"[ERROR] Envoi au plugin Godot échoué: {e}")
                # Diffusion aux écrans UI : la console/dock qui a posé la question
                # DOIT recevoir la réponse pour l'afficher.
                await manager.broadcast_ui(raw=msg)
                continue

            # Tuyau : tout le reste part à Godot + est affiché sur les écrans
            elif manager.godot_ws:
                await manager.godot_ws.send_text(msg)
            # Un ui_chat doit atteindre le CERVEAU (page app) même s'il vient
            # d'un autre client (console statique, script de test...) :
            # diffusion à tous les onglets UI, dédup via request_id.
            if isinstance(d, dict) and d.get("type") == "ui_chat":
                _ensure_request_id(d)
                await manager.broadcast_ui(raw=json.dumps(d, ensure_ascii=False))
            else:
                await manager.broadcast_ui(raw=msg)

    except WebSocketDisconnect:
        if websocket in manager.ui_sockets:
            manager.ui_sockets.remove(websocket)


# ---------- Interface (même console que le serveur du plugin) ----------
_STATIC_CANDIDATES = [
    # static/ du plugin (relay → gd4-assistance-web → gd4-assistance-app → racine)
    os.path.normpath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "..",
        "gd4-assistance-plugin", "static")),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"),
]
for _dir in _STATIC_CANDIDATES:
    if os.path.isdir(_dir):
        app.mount("/", StaticFiles(directory=_dir, html=True), name="static")
        print(f"🖥️  Interface statique servie depuis : {_dir}")
        break


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=9091, reload=True)
