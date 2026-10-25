"""Print-file maker for the NFT shirt themes (Registered owner, Brag stats, Pocket dog tag).

Layouts are the approved ones, moved here unchanged and given inputs instead of
fixed values: the artwork image, first name, title, token number, traits.
"""
import math, os
from PIL import Image as I, ImageDraw, ImageFont, ImageChops
import qrcode

HERE = os.path.dirname(os.path.abspath(__file__))
RB = os.path.join(HERE, "assets", "RB.ttf")
PXCM = 300 / 2.54
W, H = round(304.5 / 25.4 * 300), round(406 / 25.4 * 300)
CX = W // 2
YEL = (254, 242, 0); LT = (245, 245, 240); DK = (30, 33, 37)
cm = lambda v: int(round(v * PXCM))
BLOCK = cm(23.0); X0 = CX - BLOCK // 2
CREAM = (245, 245, 240)
CONTRACT = "0xBB9a30909396A055c64F2e3FB0E9C299B3fdbd4C"


def _logo():
    im = I.open(os.path.join(HERE, "assets", "logo.png")).convert("RGBA")
    return im.crop(im.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox())
LOGO = _logo()


def render(text, s, tr, fill):
    f = ImageFont.truetype(RB, int(s)); pad = 40
    wtot = int(sum(f.getlength(c) for c in text) + tr * s * (len(text) - 1)) + 2 * pad
    lay = I.new("RGBA", (wtot, int(s * 1.6)), (0, 0, 0, 0)); d = ImageDraw.Draw(lay); x = pad
    for c in text:
        d.text((x, int(s * 0.15)), c, font=f, fill=fill); x += f.getlength(c) + tr * s
    return lay.crop(lay.getchannel("A").getbbox())


def ink_line(text, fill, width=None, maxh_cm=None, tr=0.06):
    width = width or BLOCK; s = 300
    for _ in range(10):
        im = render(text, s, tr, fill)
        if abs(im.width - width) <= 1: break
        s = max(20, s * width / im.width)
    if maxh_cm and im.height > cm(maxh_cm):
        s = s * cm(maxh_cm) / im.height
        for _ in range(10):
            im = render(text, s, tr, fill)
            if abs(im.width - width) <= 1: break
            tr += (width - im.width) / (len(text) - 1) / s
    return im


def seg_line(segments, width=None, tr=0.06):
    width = width or BLOCK
    chars = [(c, fill) for text, fill in segments for c in text]
    s = 300
    for _ in range(10):
        f = ImageFont.truetype(RB, int(s)); pad = 40
        wtot = int(sum(f.getlength(c) for c, _ in chars) + tr * s * (len(chars) - 1)) + 2 * pad
        lay = I.new("RGBA", (wtot, int(s * 1.6)), (0, 0, 0, 0)); d = ImageDraw.Draw(lay); x = pad
        for c, fill in chars:
            d.text((x, int(s * 0.15)), c, font=f, fill=fill); x += f.getlength(c) + tr * s
        im = lay.crop(lay.getchannel("A").getbbox())
        if abs(im.width - width) <= 1: break
        s = max(20, s * width / im.width)
    return im


def canvas(): return I.new("RGBA", (W, H), (0, 0, 0, 0))


def paste(im, x, y):
    im.paste(x, (X0 + (BLOCK - x.width) // 2, y), x); return y + x.height


def logo(bottom=38.7):
    lw = int(BLOCK * 0.72); hh = int(LOGO.height * lw / LOGO.width)
    return LOGO.resize((lw, hh), I.LANCZOS), cm(bottom) - hh


def opensea_url(token_id):
    return "https://opensea.io/assets/matic/%s/%s" % (CONTRACT, token_id)


def qr(size_px, url):
    q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, border=2, box_size=12)
    q.add_data(url); q.make(fit=True)
    return q.make_image(fill_color="black", back_color="white").convert("RGBA").resize((size_px, size_px), I.NEAREST)


def art(nft, w, bd=0.3):
    b = cm(bd); f = I.new("RGBA", (w, w), CREAM); iw = w - 2 * b
    f.paste(nft.resize((iw, iw), I.LANCZOS), (b, b)); return f


# ---------------------------------------------------------------- Registered owner
OWNER_WORDING = {
    "major wood":    ("'S ARTWORK IS AT FULL ATTENTION,", "MAJOR WOOD IS UP AND STAYING UP"),
    "rear admiral":  ("'S ARTWORK HAS FINALLY DOCKED,", "AND THE REAR ADMIRAL IS FIRST ABOARD!"),
    "hanky":         ("'S ARTWORK IS ABSOLUTELY SPOT ON,", "AND HAMMERIN' HANKY NAILED IT!"),
    "grip":          ("'S ARTWORK IS HARD TO LET GO OF,", "AND THE GRIP IS HOLDING ON TIGHT!"),
    "willy":         ("'S ARTWORK IS HARD TO PIN DOWN,", "AND SLICK WILLY IS JUST AS SLIPPERY!"),
    "python":        ("'S ARTWORK IS A FEAST FOR THE EYES,", "THE VELVET PYTHON LICKS HIS LIPS!"),
}


def wording_for(character):
    c = (character or "").lower()
    for k, v in OWNER_WORDING.items():
        if k in c: return v
    return None


def registered_owner(nft, title, name, character, logo_bottom=38.7):
    w = wording_for(character)
    if not w: raise ValueError("no approved wording for character %r" % character)
    rest, b = w
    t = ink_line(title, LT); sub = ink_line("ONE OF ONE · DIGITAL ARTWORK", LT, maxh_cm=0.7)
    l1 = seg_line([(name, YEL), (rest, LT)]); l2 = ink_line(b, LT)
    im = I.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im); bd = cm(0.35)
    d.rectangle((X0, 0, X0 + BLOCK - 1, BLOCK - 1), fill=LT)
    im.paste(nft.resize((BLOCK - 2 * bd, BLOCK - 2 * bd), I.LANCZOS), (X0 + bd, bd))
    lw = int(BLOCK * 0.72); hh = int(LOGO.height * lw / LOGO.width); lg = LOGO.resize((lw, hh), I.LANCZOS)
    logo_top = cm(logo_bottom) - hh; y = BLOCK + cm(0.5)
    for x, g in ((t, 0.3), (sub, 1.7), (l1, 0.6), (l2, 0)):
        im.paste(x, (X0, y), x); y += x.height + cm(g)
    if (logo_top - y) / PXCM < 1.0: raise ValueError("wording too tall for the print area")
    im.paste(lg, (X0 + (BLOCK - lw) // 2, logo_top), lg)
    return im


# ---------------------------------------------------------------- Brag stats
def brag_stats(nft, name, stats):
    """stats: list of four (LABEL, value) pairs, e.g. [("RIGIDITY",99),...]"""
    im = canvas(); lg, lt = logo(); S = cm(10.8); gap = cm(1.2)
    x0 = X0 + (BLOCK - (2 * S + gap)) // 2
    o = seg_line([(name, YEL), (" OWNS THIS DIGITAL ARTWORK", LT)], width=BLOCK)
    tot = S + cm(1.3) + o.height; top = int((lt - tot) / 2) - cm(1.0)
    a = art(nft, S); im.paste(a, (x0, top), a)
    rx = x0 + S + gap; rowh = S // 4; d = ImageDraw.Draw(im); Y = YEL + (255,)
    for i, (n, v) in enumerate(stats):
        y = top + i * rowh
        lab = ink_line(n, LT, width=cm(0.62 * len(n)), maxh_cm=0.7)
        num = ink_line(str(v), YEL, width=cm(1.3), maxh_cm=0.9)
        im.paste(lab, (rx, y + cm(0.35)), lab); im.paste(num, (rx + S - num.width, y + cm(0.2)), num)
        by = y + cm(1.45); bh = cm(0.55)
        d.rectangle((rx, by, rx + S, by + bh), fill=(70, 74, 78, 255))
        d.rectangle((rx, by, rx + int(S * v / 100), by + bh), fill=Y)
    paste(im, o, top + S + cm(1.3))
    im.paste(lg, (X0 + (BLOCK - lg.width) // 2, lt), lg)
    return im


# ---------------------------------------------------------------- Pocket dog tag
def _stamp(t, im, cx, y):
    a = im.getchannel("A"); hi = I.new("RGBA", im.size, (235, 238, 242, 255)); hi.putalpha(a)
    t.paste(hi, (cx - im.width // 2 + 4, y + 4), hi); t.paste(im, (cx - im.width // 2, y), im); return y + im.height


def _tag(name, owns_text, url):
    Wt, Ht = cm(9.8), cm(18.4); t = I.new("RGBA", (Wt, Ht), (0, 0, 0, 0))
    g = I.new("RGBA", (Wt, Ht)); gd = ImageDraw.Draw(g)
    for x in range(Wt):
        v = int(178 + 38 * math.sin(x / Wt * math.pi)); gd.line((x, 0, x, Ht), fill=(v, v + 3, v + 8, 255))
    m = I.new("L", (Wt, Ht), 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, Wt - 1, Ht - 1), radius=cm(1.6), fill=255)
    t.paste(g, (0, 0), m); d = ImageDraw.Draw(t)
    d.rounded_rectangle((cm(0.3), cm(0.3), Wt - cm(0.3), Ht - cm(0.3)), radius=cm(1.3), outline=(105, 110, 116, 255), width=10)
    d.rounded_rectangle((cm(0.38), cm(0.38), Wt - cm(0.38), Ht - cm(0.38)), radius=cm(1.25), outline=(235, 238, 242, 255), width=4)
    hr = cm(0.5); hc = (Wt // 2, cm(1.9))
    hole = I.new("L", (Wt, Ht), 255); ImageDraw.Draw(hole).ellipse((hc[0] - hr, hc[1] - hr, hc[0] + hr, hc[1] + hr), fill=0)
    t.putalpha(ImageChops.multiply(t.getchannel("A"), hole))
    d.ellipse((hc[0] - hr - 8, hc[1] - hr - 8, hc[0] + hr + 8, hc[1] + hr + 8), outline=(110, 114, 120, 255), width=8)
    cx = Wt // 2; y = cm(3.4); IW = cm(7.8)
    y = _stamp(t, ink_line("STIFF COMPETITION", DK, width=IW, maxh_cm=0.9), cx, y) + cm(0.45)
    d.line((cm(1.2), y, Wt - cm(1.2), y), fill=(110, 114, 120, 255), width=6); y += cm(0.55)
    nm = ink_line(name, DK, width=IW, maxh_cm=2.0); _stamp(t, nm, cx, y + (cm(2.0) - nm.height) // 2); y += cm(2.0) + cm(0.5)
    y = _stamp(t, ink_line(owns_text, DK, width=IW, maxh_cm=0.85), cx, y) + cm(0.3)
    y = _stamp(t, ink_line("DIGITAL ARTWORK", DK, width=cm(6.0), maxh_cm=0.7), cx, y) + cm(0.8)
    q = qr(cm(7.5), url); qb = I.new("RGBA", (cm(7.8), cm(7.8)), (255, 255, 255, 255)); qb.paste(q, (cm(0.15), cm(0.15)))
    t.paste(qb, (cx - qb.width // 2, y), qb)
    return t, hc


def _chain(im, cx, cy):
    d = ImageDraw.Draw(im); n = 26
    for side in (-1, 1):
        for i in range(n):
            s = i / (n - 1); px = cx + side * (cm(0.6) + s * cm(2.6)); py = cy - cm(0.2) - cm(7.0) * math.sin(s * math.pi / 2 * 1.0) ** 1.0 * s ** 0.2
            r = cm(0.19)
            d.ellipse((px - r, py - r, px + r, py + r), fill=(150, 155, 162, 255), outline=(70, 74, 80, 255), width=3)
            d.ellipse((px - r * 0.5, py - r * 0.6, px - r * 0.1, py - r * 0.2), fill=(235, 238, 242, 255))
    r = cm(0.19)
    for ang in range(0, 360, 40):
        px = cx + cm(0.6) * math.cos(math.radians(ang)); py = cy - cm(0.25) + cm(0.45) * math.sin(math.radians(ang))
        d.ellipse((px - r, py - r, px + r, py + r), fill=(150, 155, 162, 255), outline=(70, 74, 80, 255), width=3)


def dog_tag(name, title, token_id):
    im = canvas(); t, hc = _tag(name, "OWNS " + title, opensea_url(token_id))
    x = X0 + BLOCK - t.width - cm(1.2); y = cm(7.0)
    _chain(im, x + hc[0], y + hc[1]); im.paste(t, (x, y), t)
    return im


# ---------------------------------------------------------------- NFT poster (3:4, Gelato 450 x 600 mm)
PW, PH = 5400, 7200
P_YEL = (254, 242, 0); P_OFF = (245, 245, 240); P_INK = (20, 20, 20)


def poster_colour(nft):
    """Yellow like the museum posters; off-white when the artwork's own edge is yellow, lime or green (Andy, 22 Oct 2026)."""
    import colorsys
    im = nft.convert("RGB").resize((128, 128), I.LANCZOS); px = im.load(); hs = []
    for i in range(128):
        for x, y in ((i, 0), (i, 127), (0, i), (127, i)):
            r, g, b = px[x, y]; h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if s > 0.35 and v > 0.35: hs.append(h * 360)
    share = len([h for h in hs if 50 <= h <= 150]) / 512.0
    return P_OFF if share > 0.4 else P_YEL


def _text(text, size, tr, fill):
    return render(text, size, tr, fill)


def _fit(text, cap_px, max_w, tr, fill):
    """Letters set at the wanted capital height; shrunk only when the line would be wider than max_w."""
    s = cap_px / 0.68
    im = _text(text, s, tr, fill)
    if im.width > max_w:
        s = s * max_w / im.width; im = _text(text, s, tr, fill)
    return im


def poster(nft, character, number_line, first_name):
    """character: 'MAJOR WOOD' or 'MAJOR WOOD AND SLICK WILLY'; number_line: 'TRAVEL #0022'; first_name: 'Joey'."""
    bg = poster_colour(nft)
    im = I.new("RGB", (PW, PH), bg); d = ImageDraw.Draw(im)
    side = 4656; x0 = (PW - side) // 2; y0 = 330; bd = 30
    d.rectangle((x0, y0, x0 + side - 1, y0 + side - 1), fill=P_INK)
    art = nft.convert("RGB").resize((side - 2 * bd, side - 2 * bd), I.LANCZOS)
    im.paste(art, (x0 + bd, y0 + bd))
    cx = PW // 2; y = y0 + side + 190
    n1 = _fit(character.upper(), 150, side - 700, 0.14, P_INK + (255,))
    im.paste(n1, (cx - n1.width // 2, y), n1); y += n1.height + 60
    n2 = _fit(number_line.upper(), 66, side - 1200, 0.12, P_INK + (255,))
    im.paste(n2, (cx - n2.width // 2, y), n2); y += n2.height + 130
    lg = LOGO.copy(); a = lg.getchannel("A")
    lg = I.merge("RGBA", (I.new("L", lg.size, P_INK[0]),) * 3 + (a,))
    lw = side; lh = int(lg.height * lw / lg.width)
    lg = lg.resize((lw, lh), I.LANCZOS)
    im.paste(lg, (cx - lw // 2, y), lg); y += lh + 150
    line = "%s owns this original digital artwork on the blockchain" % first_name
    n3 = _fit(line, 62, side - 900, 0.04, P_INK + (255,))
    im.paste(n3, (cx - n3.width // 2, y), n3)
    return im
