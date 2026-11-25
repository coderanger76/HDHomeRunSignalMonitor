#!/usr/bin/env python3
"""Developer tool: write a SYNTHETIC recording (label 'DEMO ...') so the Analyze page can be tested.
Known planted problems:  RF dip on 38.1 at +20 min, shared RF dip at +45 min (both channels),
network loss burst on 42.2 at +62 min, a disconnect on 38.1 at +75 min. Glitch marks at the dip/burst times + one clean one."""
import csv, json, math, os, random, sys, time
random.seed(7)
here = os.path.dirname(os.path.abspath(__file__))
sess = os.path.join(here, "..", "data", "sessions")
t0 = time.time() - 3 * 3600
sid = time.strftime("%Y-%m-%d_%H%M%S", time.localtime(t0)) + "_DEMO-synthetic"
d = os.path.join(sess, sid); os.makedirs(d, exist_ok=True)
N = 90 * 60
cols = ["t","ch","tuner","strength","quality","symbol","dev_bps","rx_bps","pkts","cc_err","cc_lost","tei","sync_loss","max_gap_ms","connected","warm","busy","dvr"]
chs = {"38.1": ("CBS-HD", 96, 6.5e6), "42.2": ("LCLCBS2", 98, 2.6e6)}
rows, ev = [], [{"t": t0, "type": "info", "ch": "", "msg": "Recording started: 38.1, 42.2"}]
down = range(75*60, 75*60+14)
for ch in chs:
    ev.append({"t": t0+0.5, "type": "connect", "ch": ch, "msg": "Tuner connected"})
ev.append({"t": t0+75*60, "type": "disconnect", "ch": "38.1", "msg": "no data for 10 seconds"})
ev.append({"t": t0+75*60+14, "type": "connect", "ch": "38.1", "msg": "Tuner connected"})
for i in range(N):
    for ch, (name, base, rate) in chs.items():
        t = t0 + i
        s = base + random.choice([-1, 0, 0, 1]) + 2*math.sin(i/400)
        q, y = 100, 100
        cc = tei = lost = 0; gap = random.randint(15, 60); conn = 1; warm = 1 if i < 4 else 0
        rx = rate * random.uniform(.8, 1.2)
        if ch == "38.1" and 20*60 <= i < 20*60+9:        # RF dip, only this channel
            k = i - 20*60; s -= 28 + 3*k % 7; q = 55 + 4*k; y = 60 + 3*k; tei = 3 + k % 4; cc = 1; rx *= .6
        if 45*60 <= i < 45*60+6:                          # shared RF dip
            k = i - 45*60; s -= 35; q = 40 + 8*k; y = 50 + 8*k; tei = 6; cc = 2; lost = 2; rx *= .4
        if ch == "42.2" and 62*60 <= i < 62*60+12:        # network loss, RF fine
            cc = random.randint(1, 4); lost = cc * 3; gap = random.choice([40, 900, 1400, 60]); rx *= random.choice([.2, .9, 0.05])
        if ch == "38.1" and i in down:
            conn = 0; s = q = y = rx = pkts = None; gap = 0
        if ch == "38.1" and i == 75*60+14: warm = 1
        if 75*60+14 < i < 75*60+18 and ch == "38.1": warm = 1
        if warm and conn: q = 0 if i < 1 else q
        rows.append([round(t,3), ch, "3" if ch == "38.1" else "0", None if s is None else round(s), q, y,
                     int(rx*0.2) if rx else 0, int(rx) if rx else 0, int((rx or 0)/1504), cc, lost, tei, 0, gap, conn, warm, 3, 1 if i % 1500 < 400 else 0])
rows.sort(key=lambda r: (r[0], r[1]))
with open(os.path.join(d, "samples.csv"), "w", newline="") as f:
    w = csv.writer(f); w.writerow(cols); w.writerows(rows)
for off, kind, ch in [(20*60+8, "pixelation", "38.1"), (45*60+7, "pixelation", ""), (62*60+9, "pixelation", "42.2"), (80*60, "freeze", "42.2")]:
    ev.append({"t": t0+off, "type": "marker", "ch": ch, "msg": "", "kind": kind})
ev.append({"t": t0+N, "type": "info", "ch": "", "msg": "Stopped by user"})
with open(os.path.join(d, "events.jsonl"), "w") as f:
    for e in sorted(ev, key=lambda e: e["t"]): f.write(json.dumps(e) + "\n")
json.dump({"id": sid, "label": "DEMO (synthetic data)", "start": t0, "end": t0+N, "status": "complete", "channels": list(chs),
           "names": {c: v[0] for c, v in chs.items()}, "device_ip": "192.168.0.0", "device": {"FriendlyName": "DEMO device"}, "link": "Wi-Fi",
           "samples": N*2, "app_version": "2.0"}, open(os.path.join(d, "meta.json"), "w"), indent=1)
print("wrote", sid)
