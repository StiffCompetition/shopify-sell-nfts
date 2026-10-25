"""Shirt print-file maker: separate small service. Makes one print file per order.
POST /render  (header X-Shirt-Secret)  -> {"url": ".../files/<id>.png"}; files expire after 2 hours.
"""
import io, os, time, uuid, threading, hmac, urllib.request
from flask import Flask, request, jsonify, send_file, abort
from PIL import Image as I
import render as R

app = Flask(__name__)
SECRET = os.environ.get("SHIRT_MAKER_SECRET", "")
BASE = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
DIR = "/tmp/prints"; os.makedirs(DIR, exist_ok=True)
TTL = 7200
THEMES = ("registered_owner", "brag_stats", "dog_tag", "poster")


def clean():
    now = time.time()
    for f in os.listdir(DIR):
        p = os.path.join(DIR, f)
        if now - os.path.getmtime(p) > TTL: os.remove(p)


def fetch(url):
    if not url.startswith("https://"): raise ValueError("image url must be https")
    req = urllib.request.Request(url, headers={"User-Agent": "shirt-maker"})
    data = urllib.request.urlopen(req, timeout=30).read(30_000_000)
    return I.open(io.BytesIO(data)).convert("RGB")


@app.get("/health")
def health(): return "ok"


@app.post("/render")
def do_render():
    if not SECRET or not hmac.compare_digest(request.headers.get("X-Shirt-Secret", ""), SECRET): abort(401)
    j = request.get_json(force=True)
    try:
        theme = j["theme"]; name = str(j["name"]).strip().upper()
        if theme not in THEMES or not name or len(name) > 24: raise ValueError("bad theme or name")
        nft = fetch(j["image_url"])
        if theme == "poster":
            im = R.poster(nft, str(j["character"]), str(j["title"]), name.capitalize())
        elif theme == "registered_owner":
            im = R.registered_owner(nft, j["title"].upper(), name, j["character"])
        elif theme == "brag_stats":
            st = [(str(a).upper(), int(b)) for a, b in j["stats"]]
            if len(st) != 4: raise ValueError("need 4 stats")
            im = R.brag_stats(nft, name, st)
        else:
            im = R.dog_tag(name, j["title"].upper(), j["token_id"])
    except Exception as e:
        return jsonify(error=str(e)), 400
    clean(); fid = uuid.uuid4().hex
    im.save(os.path.join(DIR, fid + ".png"), dpi=(300, 300))
    return jsonify(url="%s/files/%s.png" % (BASE or request.host_url.rstrip("/"), fid))


@app.get("/files/<fid>.png")
def files(fid):
    if not fid.isalnum(): abort(404)
    p = os.path.join(DIR, fid + ".png")
    if not os.path.exists(p): abort(404)
    return send_file(p, mimetype="image/png")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
