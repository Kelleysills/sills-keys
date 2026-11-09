"""Daily (GitHub Action): point the home-screen icon at today's theme (icon-<id>-192/512.png) or the normal icon.
Same date rules as the Hub / app: first theme in themes.txt (releases repo) whose dates match today in Los Angeles."""
import json, os, re, urllib.request, datetime
from zoneinfo import ZoneInfo

def load():
    try:
        t = urllib.request.urlopen("https://raw.githubusercontent.com/Kelleysills/sills-audio-releases/main/themes.txt", timeout=20).read().decode()
        body = t.replace("\r\n", "\n"); body = body[body.index("\n") + 1: body.rindex("\nsig ")]
        return json.loads(body)
    except Exception:
        return json.load(open("themes-default.json"))

def easter(y):
    a, b, c = y % 19, y // 100, y % 100; d, e = b // 4, b % 4; f = (b + 8) // 25; g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30; i, k = c // 4, c % 4; l = (32 + 2 * e + 2 * i - h - k) % 7; m = (a + 11 * h + 22 * l) // 451
    return datetime.date(y, (h + l - 7 * m + 114) // 31, ((h + l - 7 * m + 114) % 31) + 1)

def rule_day(rule, y):
    rule = str(rule).strip().lower()
    off = lambda s: int(re.search(r"([+-]\d+)$", s).group(1)) if re.search(r"([+-]\d+)$", s) else 0
    if rule.startswith("easter"): return easter(y) + datetime.timedelta(off(rule[6:]))
    if rule.startswith("nth:"):
        n, dow, mp = rule[4:].split(":"); mm = re.match(r"^(\d+)([+-]\d+)?$", mp)
        dw = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].index(dow[:3]); month, o, n = int(mm.group(1)), int(mm.group(2) or 0), int(n)
        if n > 0:
            first = datetime.date(y, month, 1); return first + datetime.timedelta((dw - first.weekday()) % 7 + 7 * (n - 1) + o)
        last = (datetime.date(y + (month == 12), month % 12 + 1, 1) - datetime.timedelta(1))
        return last - datetime.timedelta((last.weekday() - dw) % 7 - o)
    m = re.match(r"^(\d{1,2})-(\d{1,2})(\+\d+)?$", rule)
    return datetime.date(y, int(m.group(1)), int(m.group(2))) + datetime.timedelta(int(m.group(3) or 0))

def matches(when, today):
    for r in when or []:
        for y in (today.year - 1, today.year):
            try:
                a = rule_day(r["from"], y); b = rule_day(r.get("to", r["from"]), y)
                if b < a: b = rule_day(r["to"], y + 1)
                if a <= today <= b: return True
            except Exception: pass
    return False

today = datetime.datetime.now(ZoneInfo("America/Los_Angeles")).date()
doc = load()
theme = next((t["id"] for t in doc.get("themes", []) if matches(t.get("when"), today)), None)
prefix = f"icon-{theme}-" if theme and os.path.exists(f"icon-{theme}-192.png") else "icon-"
m = open("manifest.webmanifest").read()
m2 = re.sub(r'"icon-[a-z0-9]*-?(192|512)\.png"', lambda x: f'"{prefix}{x.group(1)}.png"', m)
if m2 != m: open("manifest.webmanifest", "w").write(m2); print("icon ->", prefix)
else: print("icon already", prefix)
