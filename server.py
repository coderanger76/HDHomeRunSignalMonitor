#!/usr/bin/env python3
"""HDHomeRun Signal Monitor - local web app.

Runs a small web server on THIS computer (127.0.0.1 only) and talks to an HDHomeRun on the
home network. Open http://localhost:8787 in Safari.

  * Python 3.9+ and the standard library only. Nothing to pip-install.
  * While recording, each chosen channel is streamed from the HDHomeRun (this occupies one tuner
    per channel), and once per second we log: signal strength / quality / symbol quality reported
    by the tuner, the bitrate actually received, and MPEG-TS stream integrity (continuity errors,
    transport-error flags, stalls). That combination tells RF problems apart from network problems.
  * Recordings are saved under ./data/sessions/<id>/ (samples.csv, events.jsonl, meta.json).
"""
import argparse
import collections
import csv
import json
import os
import re
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
DATA_DIR = os.path.join(APP_DIR, "data")
SESS_DIR = os.path.join(DATA_DIR, "sessions")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
VERSION = "2.0"

WARM_SECS = 4          # first seconds after (re)connecting: tuner is still locking, readings are not meaningful
STALL_MS = 750         # no stream data for this long inside one second = a stall
GLITCH_WINDOW = (15, 3)  # seconds before / after a "glitch" click that we search for a cause
COLUMNS = ["t", "ch", "tuner", "strength", "quality", "symbol", "dev_bps", "rx_bps", "pkts",
           "cc_err", "cc_lost", "tei", "sync_loss", "max_gap_ms", "connected", "warm", "busy", "dvr"]


# --------------------------------------------------------------------------- small helpers
def now():
    return time.time()


def ensure_dirs():
    os.makedirs(SESS_DIR, exist_ok=True)


def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def save_config(cfg):
    ensure_dirs()
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f)
    os.replace(tmp, CONFIG_PATH)


def slug(s):
    s = re.sub(r"[^A-Za-z0-9]+", "-", s or "").strip("-")
    return s[:30]


def num(x, nd=1):
    return None if x is None else round(x, nd)


def percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def valid_host(h):
    return bool(re.match(r"^[A-Za-z0-9]([A-Za-z0-9.\-]{0,60}[A-Za-z0-9])?$", h or ""))


def valid_channel(c):
    return bool(re.match(r"^\d{1,3}(\.\d{1,3})?$", c or ""))


def link_type(ip):
    """Best-effort: is the path to the HDHomeRun on Wi-Fi or Ethernet? (macOS only; returns 'unknown' otherwise)"""
    try:
        out = subprocess.run(["route", "-n", "get", ip], capture_output=True, text=True, timeout=3).stdout
        m = re.search(r"interface:\s*(\S+)", out)
        if not m:
            return "unknown"
        dev = m.group(1)
        hw = subprocess.run(["networksetup", "-listallhardwareports"], capture_output=True, text=True, timeout=3).stdout
        for block in hw.split("\n\n"):
            pm = re.search(r"Hardware Port:\s*(.+)", block)
            dm = re.search(r"Device:\s*(\S+)", block)
            if pm and dm and dm.group(1) == dev:
                port = pm.group(1).strip()
                return "Wi-Fi" if "wi-fi" in port.lower() or "airport" in port.lower() else port
        return dev
    except Exception:
        return "unknown"


# --------------------------------------------------------------------------- discovery
def discover_devices(timeout=1.5):
    """Find HDHomeRun devices with the same UDP broadcast the official tools use."""
    payload = struct.pack(">BB", 0x01, 4) + b"\xff" * 4 + struct.pack(">BB", 0x02, 4) + b"\xff" * 4
    pkt = struct.pack(">HH", 0x0002, len(payload)) + payload
    pkt += struct.pack("<I", zlib.crc32(pkt) & 0xFFFFFFFF)
    found = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.settimeout(0.25)
        s.sendto(pkt, ("255.255.255.255", 65001))
        end = time.time() + timeout
        while time.time() < end:
            try:
                data, addr = s.recvfrom(2048)
            except socket.timeout:
                continue
            except OSError:
                break
            if len(data) < 8 or struct.unpack(">H", data[:2])[0] != 0x0003:
                continue
            plen = struct.unpack(">H", data[2:4])[0]
            body, i, dev_id = data[4:4 + plen], 0, None
            while i + 2 <= len(body):
                tag, ln = body[i], body[i + 1]
                i += 2
                if ln & 0x80 and i < len(body):
                    ln = (ln & 0x7F) | (body[i] << 7)
                    i += 1
                val = body[i:i + ln]
                i += ln
                if tag == 0x02 and len(val) == 4:
                    dev_id = val.hex().upper()
            found[addr[0]] = dev_id
    except Exception:
        pass
    finally:
        s.close()
    if not found:  # fallback: mDNS name used by some firmware
        try:
            found[socket.gethostbyname("hdhomerun.local")] = None
        except Exception:
            pass
    return [{"ip": ip, "id": did} for ip, did in found.items()]


# --------------------------------------------------------------------------- device access
class Device:
    def __init__(self):
        self.ip = None
        self.info = {}
        self.lock = threading.Lock()
        self._status = (0, None, None)   # (time, data, error)
        self._lineup = (0, None)

    def set_ip(self, ip):
        with self.lock:
            self.ip = ip
            self.info = {}
            self._status = (0, None, None)
            self._lineup = (0, None)

    def get(self, path, timeout=4):
        if not self.ip:
            raise RuntimeError("No HDHomeRun selected")
        with urllib.request.urlopen("http://%s/%s" % (self.ip, path), timeout=timeout) as r:
            return json.load(r)

    def refresh_info(self):
        d = self.get("discover.json")
        # DeviceAuth is a private token; never keep or send it onwards.
        self.info = {k: d.get(k) for k in ("FriendlyName", "ModelNumber", "FirmwareVersion", "DeviceID", "TunerCount")}
        return self.info

    def status(self, max_age=0.8):
        with self.lock:
            t, data, err = self._status
        if data is not None and now() - t < max_age:
            return data, None
        try:
            data = self.get("status.json", timeout=3)
            with self.lock:
                self._status = (now(), data, None)
            return data, None
        except Exception as e:
            with self.lock:
                self._status = (now(), None, str(e))
            return None, str(e)

    def lineup(self):
        with self.lock:
            t, data = self._lineup
        if data is not None and now() - t < 120:
            return data
        raw = self.get("lineup.json?show=all", timeout=8)
        data = [{"ch": c.get("GuideNumber"), "name": c.get("GuideName"), "hd": bool(c.get("HD")),
                 "fav": bool(c.get("Favorite")), "codec": c.get("VideoCodec")} for c in raw]
        data.sort(key=lambda c: [int(p) for p in c["ch"].split(".")])
        with self.lock:
            self._lineup = (now(), data)
        return data


DEVICE = Device()


# --------------------------------------------------------------------------- stream reader
class StreamReader(threading.Thread):
    """Pulls one channel's MPEG-TS stream from the HDHomeRun and counts what arrives."""

    def __init__(self, ip, ch, on_event):
        super().__init__(daemon=True, name="stream-" + ch)
        self.ip, self.ch, self.on_event = ip, ch, on_event
        self.stop_flag = threading.Event()
        self.lock = threading.Lock()
        self.sock = None
        self.local_ip = None
        self.connected = False
        self.connected_at = 0.0
        self.last_rx = time.monotonic()
        self._reset_counters()
        self.ccs = {}

    def _reset_counters(self):
        self.bytes = self.pkts = self.cc_err = self.cc_lost = self.tei = self.sync_loss = 0
        self.max_gap = 0.0

    def stop(self):
        self.stop_flag.set()
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass

    def snapshot(self):
        """Counters since the last snapshot (one second ago), then reset."""
        t = time.monotonic()
        with self.lock:
            gap = max(self.max_gap, (t - self.last_rx) if self.connected else 0.0)
            snap = dict(bytes=self.bytes, pkts=self.pkts, cc_err=self.cc_err, cc_lost=self.cc_lost, tei=self.tei,
                        sync_loss=self.sync_loss, max_gap_ms=int(gap * 1000), connected=self.connected,
                        warm=self.connected and (t - self.connected_at < WARM_SECS), local_ip=self.local_ip)
            self._reset_counters()
        return snap

    def _connect(self):
        s = socket.create_connection((self.ip, 5004), timeout=6)
        s.settimeout(4)
        self.sock = s
        s.sendall(("GET /auto/v%s HTTP/1.0\r\nHost: %s\r\nUser-Agent: hdhr-monitor\r\n\r\n" % (self.ch, self.ip)).encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                raise ConnectionError("device closed the connection")
            buf += chunk
            if len(buf) > 65536:
                raise ConnectionError("bad HTTP response")
        head, _, rest = buf.partition(b"\r\n\r\n")
        line = head.split(b"\r\n", 1)[0].decode("latin1")
        code = int(line.split()[1]) if len(line.split()) > 1 else 0
        if code != 200:
            reason = {503: "all tuners are busy", 404: "channel not found"}.get(code, line)
            raise ConnectionError("HTTP %d: %s" % (code, reason))
        return s, rest

    def run(self):
        while not self.stop_flag.is_set():
            try:
                s, rest = self._connect()
                with self.lock:
                    self.local_ip = s.getsockname()[0]
                    self.connected = True
                    self.connected_at = self.last_rx = time.monotonic()
                    self.max_gap = 0.0
                self.ccs = {}
                self.carry = b""
                self.on_event("connect", self.ch, "Tuner connected")
                if rest:
                    self._feed(rest)
                while not self.stop_flag.is_set():
                    try:
                        data = s.recv(262144)
                    except socket.timeout:
                        if time.monotonic() - self.last_rx > 10:
                            raise ConnectionError("no data for 10 seconds")
                        continue
                    if not data:
                        raise ConnectionError("stream ended")
                    self._feed(data)
            except Exception as e:
                if not self.stop_flag.is_set():
                    self.on_event("disconnect", self.ch, str(e))
            finally:
                with self.lock:
                    self.connected = False
                try:
                    if self.sock:
                        self.sock.close()
                except Exception:
                    pass
            if self.stop_flag.wait(3):
                break

    def _feed(self, data):
        t = time.monotonic()
        buf = self.carry + data
        n = len(buf)
        ccs = self.ccs
        i = pk = tei = cce = lost = sync = 0
        while i + 188 <= n:
            if buf[i] != 0x47:                      # lost packet alignment: hunt for the next sync byte
                sync += 1
                j = buf.find(b"\x47", i + 1)
                while j != -1 and j + 188 < n and buf[j + 188] != 0x47:
                    j = buf.find(b"\x47", j + 1)
                if j == -1:
                    i = n
                    break
                i = j
                continue
            b1 = buf[i + 1]
            pid = ((b1 & 0x1F) << 8) | buf[i + 2]
            b3 = buf[i + 3]
            pk += 1
            if b1 & 0x80:
                tei += 1
            if pid != 0x1FFF:
                afc = (b3 >> 4) & 3
                if afc & 2 and buf[i + 4] > 0 and buf[i + 5] & 0x80:   # discontinuity indicator: counter may jump legally
                    ccs.pop(pid, None)
                if afc & 1:
                    cc = b3 & 0x0F
                    last = ccs.get(pid)
                    if last is not None and cc != last and cc != ((last + 1) & 0x0F):
                        cce += 1
                        lost += (cc - last - 1) & 0x0F
                    ccs[pid] = cc
            i += 188
        self.carry = buf[i:] if (n - i) < 188 + 188 else b""
        with self.lock:
            gap = t - self.last_rx
            if gap > self.max_gap:
                self.max_gap = gap
            self.last_rx = t
            self.bytes += len(data)
            self.pkts += pk
            self.tei += tei
            self.cc_err += cce
            self.cc_lost += lost
            self.sync_loss += sync


# --------------------------------------------------------------------------- recorder
class Recorder:
    def __init__(self):
        self.lock = threading.RLock()
        self.active = False
        self.sid = None
        self.readers = {}
        self.thread = None
        self.stop_flag = threading.Event()
        self.history = {}
        self.latest = {}
        self.markers = []
        self.messages = collections.deque(maxlen=12)
        self.t0 = 0
        self.limit_s = 0
        self.label = ""
        self.channels = []
        self.names = {}
        self.sample_count = 0
        self.last_finished = None
        self.caff = None
        self.csv_f = self.ev_f = None
        self.csv_w = None

    # -- events / markers
    def add_event(self, kind, ch, msg, extra=None):
        rec = {"t": round(now(), 3), "type": kind, "ch": ch, "msg": msg}
        if extra:
            rec.update(extra)
        with self.lock:
            if self.ev_f:
                self.ev_f.write(json.dumps(rec) + "\n")
                self.ev_f.flush()
            if kind in ("connect", "disconnect", "info", "error"):
                self.messages.append({"t": rec["t"], "ch": ch, "msg": msg, "type": kind})
            if kind == "marker":
                self.markers.append(rec)
        return rec

    def add_marker(self, kind, ch, note):
        with self.lock:
            if not self.active:
                raise RuntimeError("Not recording")
        return self.add_event("marker", ch or "", note or "", {"kind": kind})

    # -- start / stop
    def start(self, channels, label, hours):
        with self.lock:
            if self.active:
                raise RuntimeError("Already recording")
            ip = DEVICE.ip
            if not ip:
                raise RuntimeError("No HDHomeRun selected")
            try:
                lineup = {c["ch"]: c for c in DEVICE.lineup()}
            except Exception as e:
                raise RuntimeError("Can't reach the HDHomeRun at %s (%s). Check that it is powered on and on the same network." % (ip, e))
            channels = [c for c in dict.fromkeys(channels) if c in lineup]
            if not channels:
                raise RuntimeError("Choose at least one channel")
            status, err = DEVICE.status(0)
            if status is None:
                raise RuntimeError("Can't reach the HDHomeRun: %s" % err)
            free = sum(1 for t in status if t.get("Resource", "").startswith("tuner") and "Frequency" not in t)
            if len(channels) > free:
                raise RuntimeError("You picked %d channel(s) but only %d tuner(s) are free right now "
                                   "(the others are in use, e.g. by a recording or someone watching)." % (len(channels), free))
            ensure_dirs()
            t0 = now()
            sid = time.strftime("%Y-%m-%d_%H%M%S", time.localtime(t0))
            if slug(label):
                sid += "_" + slug(label)
            d = os.path.join(SESS_DIR, sid)
            os.makedirs(d)
            self.sid, self.t0, self.label, self.channels = sid, t0, (label or "").strip()[:80], channels
            self.names = {c: lineup[c]["name"] for c in channels}
            self.limit_s = int(hours * 3600) if hours else 0
            self.markers, self.messages = [], collections.deque(maxlen=12)
            self.history = {c: collections.deque(maxlen=600) for c in channels}
            self.latest = {}
            self.sample_count = 0
            self.csv_f = open(os.path.join(d, "samples.csv"), "w", newline="")
            self.csv_w = csv.writer(self.csv_f)
            self.csv_w.writerow(COLUMNS)
            self.ev_f = open(os.path.join(d, "events.jsonl"), "w")
            self.meta = {
                "id": sid, "label": self.label, "start": t0, "end": None, "status": "recording",
                "channels": channels, "names": self.names, "device_ip": ip, "device": dict(DEVICE.info),
                "link": link_type(ip), "host": socket.gethostname(), "app_version": VERSION, "limit_s": self.limit_s,
            }
            self._write_meta()
            self.stop_flag.clear()
            self.readers = {c: StreamReader(ip, c, self.add_event) for c in channels}
            self.active = True
            for r in self.readers.values():
                r.start()
            try:   # keep the Mac awake while recording
                self.caff = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])
            except Exception:
                self.caff = None
            self.add_event("info", "", "Recording started: " + ", ".join(channels))
            self.thread = threading.Thread(target=self._sampler, daemon=True, name="sampler")
            self.thread.start()
            return sid

    def _write_meta(self):
        tmp = os.path.join(SESS_DIR, self.sid, "meta.json.tmp")
        with open(tmp, "w") as f:
            json.dump(self.meta, f, indent=1)
        os.replace(tmp, os.path.join(SESS_DIR, self.sid, "meta.json"))

    def stop(self, reason="Stopped"):
        with self.lock:
            if not self.active:
                return None
            self.active = False
            self.stop_flag.set()
            readers = list(self.readers.values())
        for r in readers:
            r.stop()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=5)
        with self.lock:
            self.add_event("info", "", reason)
            self.meta["end"] = now()
            self.meta["status"] = "complete"
            self.meta["samples"] = self.sample_count
            self._write_meta()
            for f in (self.csv_f, self.ev_f):
                try:
                    f.close()
                except Exception:
                    pass
            self.csv_f = self.ev_f = None
            if self.caff:
                try:
                    self.caff.terminate()
                except Exception:
                    pass
                self.caff = None
            self.readers = {}
            self.last_finished = {"id": self.sid, "samples": self.sample_count, "label": self.label}
            return self.sid

    # -- 1 Hz sampler
    def _sampler(self):
        nxt = time.time()
        while not self.stop_flag.is_set():
            nxt += 1.0
            if self.stop_flag.wait(max(0, nxt - time.time())):
                break
            try:
                self._sample()
            except Exception as e:
                self.add_event("error", "", "sampler: %s" % e)
            if self.limit_s and now() - self.t0 >= self.limit_s:
                threading.Thread(target=self.stop, args=("Time limit reached",), daemon=True).start()
                break

    def _sample(self):
        t = now()
        status, err = DEVICE.status(0.5)
        entries = [e for e in (status or []) if e.get("Resource", "").startswith("tuner")]
        busy = sum(1 for e in entries if "Frequency" in e)
        dvr = sum(1 for e in (status or []) if e.get("Resource") == "record")
        with self.lock:
            readers = list(self.readers.items())
            for ch, r in readers:
                s = r.snapshot()
                mine = [e for e in entries if e.get("VctNumber") == ch]
                pick = None
                for e in mine:   # our own stream is the one aimed at this computer
                    if s["local_ip"] and e.get("TargetIP") == s["local_ip"]:
                        pick = e
                if pick is None:
                    mine = [e for e in mine if e.get("TargetIP") not in ("[::1]", "::1", "127.0.0.1")]
                    pick = mine[0] if mine else None
                st = pick or {}
                row = [round(t, 3), ch, (st.get("Resource") or "").replace("tuner", ""), st.get("SignalStrengthPercent"),
                       st.get("SignalQualityPercent"), st.get("SymbolQualityPercent"), st.get("NetworkRate"),
                       s["bytes"] * 8, s["pkts"], s["cc_err"], s["cc_lost"], s["tei"], s["sync_loss"], s["max_gap_ms"],
                       int(s["connected"]), int(s["warm"]), busy, dvr]
                self.csv_w.writerow(row)
                self.latest[ch] = dict(zip(COLUMNS, row))
                self.history[ch].append([row[0], row[3], row[4], row[5], round(row[7] / 1e6, 2), row[9] + row[11],
                                         row[13], row[15], row[14]])
                self.sample_count += 1
            self.csv_f.flush()

    # -- state for the browser
    def public_state(self):
        with self.lock:
            st = {"active": self.active, "id": self.sid if self.active else None,
                  "last_finished": self.last_finished}
            if self.active:
                st.update({"label": self.label, "started": self.t0, "elapsed": now() - self.t0, "limit_s": self.limit_s,
                           "channels": self.channels, "names": self.names, "latest": self.latest,
                           "history": {c: list(h) for c, h in self.history.items()},
                           "markers": self.markers, "messages": list(self.messages)})
            return st


REC = Recorder()


# --------------------------------------------------------------------------- sessions & analysis
def safe_sid(sid):
    return bool(re.match(r"^[A-Za-z0-9_\-]{6,80}$", sid or "")) and os.path.isdir(os.path.join(SESS_DIR, sid))


def _read_events(d):
    out = []
    try:
        with open(os.path.join(d, "events.jsonl")) as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except Exception:
        pass
    return out


def list_sessions():
    out = []
    if not os.path.isdir(SESS_DIR):
        return out
    for sid in sorted(os.listdir(SESS_DIR), reverse=True):
        d = os.path.join(SESS_DIR, sid)
        try:
            with open(os.path.join(d, "meta.json")) as f:
                meta = json.load(f)
        except Exception:
            continue
        csvp = os.path.join(d, "samples.csv")
        n, last_t = 0, None
        try:
            with open(csvp, "rb") as f:
                for line in f:
                    n += 1
                    if line[:1].isdigit():
                        last_t = line.split(b",", 1)[0]
            n = max(0, n - 1)
        except Exception:
            pass
        end = meta.get("end") or (float(last_t) if last_t else meta.get("start"))
        markers = sum(1 for e in _read_events(d) if e.get("type") == "marker")
        is_live = REC.active and REC.sid == sid
        out.append({"id": sid, "label": meta.get("label", ""), "start": meta.get("start"), "end": end,
                    "channels": meta.get("channels", []), "names": meta.get("names", {}), "samples": n,
                    "markers": markers, "live": is_live,
                    "interrupted": meta.get("status") == "recording" and not is_live})
    return out


def _f(x):
    if x in ("", None):
        return None
    try:
        v = float(x)
        return int(v) if v == int(v) else v
    except ValueError:
        return None


def load_session(sid):
    d = os.path.join(SESS_DIR, sid)
    with open(os.path.join(d, "meta.json")) as f:
        meta = json.load(f)
    cols, seen_conn = {}, {}
    with open(os.path.join(d, "samples.csv"), newline="") as f:
        for r in csv.DictReader(f):
            ch = r.get("ch")
            if not ch:
                continue
            c = cols.setdefault(ch, {k: [] for k in COLUMNS if k not in ("ch",)})
            conn = _f(r.get("connected")) or 0
            warm = _f(r.get("warm")) or 0
            if conn:
                seen_conn[ch] = True
            elif not seen_conn.get(ch):
                warm = 1            # still making the very first connection: not a fault
            blank = warm or not conn   # tuner (re)locking or stream down: readings are meaningless, so blank them
            for k in COLUMNS:
                if k == "ch":
                    continue
                v = _f(r.get(k))
                if k == "warm":
                    v = warm
                elif blank and k in ("strength", "quality", "symbol", "dev_bps", "rx_bps", "cc_err", "cc_lost", "tei",
                                     "max_gap_ms", "pkts", "sync_loss"):
                    v = None
                c[k].append(v)
    events = _read_events(d)
    if not meta.get("end") and cols:
        meta["end"] = max(c["t"][-1] for c in cols.values() if c["t"])
    return meta, cols, events


def _stats(vals, nd=1):
    v = sorted(x for x in vals if x is not None)
    if not v:
        return None
    return {"min": num(v[0], nd), "avg": num(sum(v) / len(v), nd), "p5": num(percentile(v, 0.05), nd), "max": num(v[-1], nd)}


def _detect_events(c):
    """Group consecutive 'bad' seconds into events (gaps up to 3 s are bridged)."""
    t = c["t"]
    evs, cur = [], None
    for i in range(len(t)):
        if c["warm"][i]:
            continue
        s, q, y = c["strength"][i], c["quality"][i], c["symbol"][i]
        rf = (q is not None and q < 90) or (y is not None and y < 90) or (s is not None and s < 40)
        st = ((c["cc_err"][i] or 0) > 0) or ((c["tei"][i] or 0) > 0) or ((c["max_gap_ms"][i] or 0) > STALL_MS) \
            or c["rx_bps"][i] == 0 or not c["connected"][i]
        if not (rf or st):
            continue
        if cur and t[i] - cur["t1"] <= 3:
            cur["t1"] = t[i]
        else:
            cur = {"t0": t[i], "t1": t[i], "rf": False, "stream": False, "min_q": None, "min_y": None, "min_s": None,
                   "cc": 0, "lost": 0, "tei": 0, "max_gap": 0, "min_rx": None}
            evs.append(cur)
        cur["rf"] = cur["rf"] or rf
        cur["stream"] = cur["stream"] or st
        for key, v in (("min_q", q), ("min_y", y), ("min_s", s)):
            if v is not None and (cur[key] is None or v < cur[key]):
                cur[key] = v
        cur["cc"] += c["cc_err"][i] or 0
        cur["lost"] += c["cc_lost"][i] or 0
        cur["tei"] += c["tei"][i] or 0
        cur["max_gap"] = max(cur["max_gap"], c["max_gap_ms"][i] or 0)
        rx = c["rx_bps"][i]
        if rx is not None and (cur["min_rx"] is None or rx < cur["min_rx"]):
            cur["min_rx"] = rx
    for e in evs:
        e["dur"] = round(e["t1"] - e["t0"] + 1)
        e["kind"] = "both" if (e["rf"] and e["stream"]) else ("rf" if e["rf"] else "stream")
        major = (e["min_q"] is not None and e["min_q"] < 70) or e["max_gap"] > 2000 or e["lost"] >= 5 or e["dur"] >= 5
        e["severity"] = "major" if major else "minor"
        e["min_rx"] = num((e["min_rx"] or 0) / 1e6, 2) if e["min_rx"] is not None else None
    return evs


def analyze_session(meta, cols, events):
    chans = [c for c in meta.get("channels", []) if c in cols] or list(cols)
    out_channels, all_events = [], {}
    for ch in chans:
        c = cols[ch]
        n = len(c["t"])
        good = [i for i in range(n) if not c["warm"][i]]
        evs = _detect_events(c)
        all_events[ch] = evs
        total_cc = sum(c["cc_err"][i] or 0 for i in good)
        total_lost = sum(c["cc_lost"][i] or 0 for i in good)
        total_tei = sum(c["tei"][i] or 0 for i in good)
        stall_secs = sum(1 for i in good if (c["max_gap_ms"][i] or 0) > STALL_MS or c["rx_bps"][i] == 0 or not c["connected"][i])
        q_low = sum(1 for i in good if c["quality"][i] is not None and c["quality"][i] < 90)
        q_bad = sum(1 for i in good if c["quality"][i] is not None and c["quality"][i] < 70)
        s_weak = sum(1 for i in good if c["strength"][i] is not None and c["strength"][i] < 40)
        rx = [c["rx_bps"][i] / 1e6 if c["rx_bps"][i] is not None else None for i in good]
        busy = _stats([c["busy"][i] for i in range(n)], 1)
        reconnects = sum(1 for e in events if e.get("type") == "disconnect" and e.get("ch") == ch)
        out_channels.append({
            "ch": ch, "name": (meta.get("names") or {}).get("%s" % ch, ""), "samples": len(good),
            "seconds": round(c["t"][-1] - c["t"][0] + 1) if n else 0,
            "strength": _stats([c["strength"][i] for i in good]), "quality": _stats([c["quality"][i] for i in good]),
            "symbol": _stats([c["symbol"][i] for i in good]), "rx_mbps": _stats(rx, 2),
            "pct_quality_low": num(100.0 * q_low / len(good), 2) if good else None,
            "pct_quality_bad": num(100.0 * q_bad / len(good), 2) if good else None,
            "weak_secs": s_weak, "cc_err": total_cc, "cc_lost": total_lost, "tei": total_tei,
            "stall_secs": stall_secs, "reconnects": reconnects, "events": evs, "tuners_busy": busy,
            "dvr_seconds": sum(1 for i in range(n) if c["dvr"][i]),
        })

    # ---- match the viewer's "I see a glitch" clicks against what the instruments saw
    glitches = []
    markers = [e for e in events if e.get("type") == "marker"]
    for k, m in enumerate(markers, 1):
        w0, w1 = m["t"] - GLITCH_WINDOW[0], m["t"] + GLITCH_WINDOW[1]
        scope = [m["ch"]] if m.get("ch") in cols else chans
        kinds, ctx, had_data = set(), {"min_q": None, "min_s": None, "cc": 0, "gap": 0}, False
        for ch in scope:
            c = cols[ch]
            for i, t in enumerate(c["t"]):
                if w0 <= t <= w1 and not c["warm"][i]:
                    had_data = True
                    for key, v in (("min_q", c["quality"][i]), ("min_s", c["strength"][i])):
                        if v is not None and (ctx[key] is None or v < ctx[key]):
                            ctx[key] = v
                    ctx["cc"] += (c["cc_err"][i] or 0) + (c["tei"][i] or 0)
                    ctx["gap"] = max(ctx["gap"], c["max_gap_ms"][i] or 0)
            for e in all_events.get(ch, []):
                if e["t1"] >= w0 and e["t0"] <= w1:
                    kinds.add(e["kind"])
        if not had_data:
            result = "nodata"
        elif not kinds:
            result = "none"
        elif kinds == {"rf"}:
            result = "rf"
        elif kinds == {"stream"}:
            result = "stream"
        else:
            result = "both"
        glitches.append({"n": k, "t": m["t"], "kind": m.get("kind", "pixelation"), "note": m.get("msg", ""),
                         "ch": m.get("ch", ""), "result": result, **ctx})

    return {"channels": out_channels, "glitches": glitches, "findings": _findings(meta, out_channels, glitches)}


def _findings(meta, chs, glitches):
    F = []

    def add(level, title, text):
        F.append({"level": level, "title": title, "text": text})

    link = meta.get("link", "unknown")
    if not chs or all(c["samples"] == 0 for c in chs):
        add("info", "Not enough data yet", "This recording has no usable readings (it may have been too short or the tuner never locked).")
        return F
    dur = max(c["seconds"] for c in chs)
    tot_rf = sum(1 for c in chs for e in c["events"] if e["rf"])
    tot_st = sum(1 for c in chs for e in c["events"] if e["stream"])
    marked = [g for g in glitches if g["result"] != "nodata"]
    n = len(marked)
    n_rf = sum(1 for g in marked if g["result"] in ("rf", "both"))
    n_st = sum(1 for g in marked if g["result"] in ("stream", "both"))
    n_none = sum(1 for g in marked if g["result"] == "none")

    # ---- headline
    if n:
        if n_none == n:
            add("warn", "The instruments saw nothing wrong at the moment%s you marked" % ("" if n == 1 else "s"),
                ("The glitch you marked happened" if n == 1 else "All %d glitches you marked happened" % n) +
                " while signal strength, signal quality and the stream from the HDHomeRun were clean. "
                "So the damage is probably happening AFTER the HDHomeRun: the player (Tablo, TV, or app), the Wi-Fi/network path to that "
                "player, or the broadcast itself (a problem at the TV station sends bad video that no antenna can fix). "
                "Best next test: watch the same channel on a second device and see whether it pixelates at the same time.")
        elif n_rf >= max(1, 0.5 * n) and n_st < 0.5 * n:
            add("bad", "Radio-signal problem: %d of %d marked glitch%s lined up with a drop in signal" % (n_rf, n, "" if n == 1 else "es"),
                "Strength and/or quality dipped when the picture broke up. That points at the antenna side: loose or corroded coax connectors, "
                "a bad splitter or amplifier, antenna position, or interference (LED bulbs, power supplies, cell/radio signals, "
                "airplanes and weather causing fading).")
        elif n_st >= max(1, 0.5 * n) and n_rf < 0.5 * n:
            add("bad", "Network/stream problem: %d of %d marked glitch%s lined up with lost or stalled video data" % (n_st, n, "" if n == 1 else "es"),
                "The radio signal stayed good, but video data from the HDHomeRun to this computer was lost or stalled. "
                "That points at the home network, not the antenna." + (" This computer reaches the HDHomeRun over Wi-Fi - try Ethernet (cable) or move closer to the router." if link == "Wi-Fi" else ""))
        else:
            add("bad", "Mixed: %d marked glitch%s matched signal drops and %d matched stream errors" % (n_rf, "" if n_rf == 1 else "es", n_st),
                "Both the radio signal and the data stream showed trouble around your marks. Fix the radio side first (check coax connections "
                "and antenna), then re-test; poor signal and network loss can both cause pixelation.")
        if 0 < n_none < n:
            add("info", "%d of %d marks had no matching instrument event" % (n_none, n),
                "Some glitches may be downstream of the HDHomeRun, or the click may have come more than %ds after the glitch." % GLITCH_WINDOW[0])
    else:
        if tot_rf == 0 and tot_st == 0:
            add("good", "Signal and stream were clean for the whole recording (%s)" % _dur(dur),
                "No dips, no lost video data and no stalls. If the picture still pixelates, the cause is probably downstream of the "
                "HDHomeRun (player, TV, Tablo, Wi-Fi to the player) or at the broadcaster. Next time press a 'Mark glitch' button the "
                "moment you see it so the report can check that exact moment.")
        else:
            add("warn", "%d signal dip(s) and %d stream error event(s) were detected, but no glitches were marked" % (tot_rf, tot_st),
                "Press one of the 'Mark glitch' buttons whenever the picture breaks up so the report can tell which events actually matter.")

    # ---- per-channel health notes
    for c in chs:
        label = "%s %s" % (c["ch"], c["name"])
        s, q = c["strength"], c["quality"]
        if s and s["avg"] is not None:
            if s["avg"] < 40:
                add("bad", "%s: signal is weak (average strength %s%%)" % (label, s["avg"]),
                    "Weak signal causes pixelation. Try repositioning the antenna (higher, near a window), check cable connections, "
                    "remove unnecessary splitters, or add a distribution amplifier.")
            elif s["avg"] < 60:
                add("warn", "%s: signal strength is on the low side (average %s%%)" % (label, s["avg"]),
                    "Usable but with little margin: any extra loss (weather, a cable flex) can push it into dropouts.")
            if s["max"] is not None and s["min"] is not None and s["max"] - s["min"] >= 25:
                add("warn", "%s: signal strength swung by %d points (%s%% to %s%%)" % (label, s["max"] - s["min"], s["min"], s["max"]),
                    "A fluctuating signal often means multipath (reflections), a loose connector, or something moving/switching nearby.")
        strong_dips = [e for e in c["events"] if e["rf"] and e["min_s"] is not None and e["min_s"] >= 85
                       and e["min_q"] is not None and e["min_q"] < 90]
        if strong_dips:
            add("info", "%s: %d quality drop(s) happened while the signal was still very strong" % (label, len(strong_dips)),
                "Good strength but poor quality points to interference or reflections (multipath), or - if an amplifier is installed - a signal "
                "so strong it overloads the tuner. Try a different amplifier setting or an attenuator, and check for nearby interference.")
        if c["cc_lost"] or c["stall_secs"] or c["tei"]:
            add("warn" if (c["cc_lost"] < 50 and c["stall_secs"] < 5) else "bad",
                "%s: stream integrity - %d lost-packet event(s) (~%d packets), %d stalled second(s), %d error-flagged packet(s)" %
                (label, c["cc_err"], c["cc_lost"], c["stall_secs"], c["tei"]),
                "Lost packets or stalls between the HDHomeRun and this computer show up as blocky or frozen video. "
                "Error-flagged packets (as opposed to lost packets) come from weak RF reception.")
        if c["reconnects"]:
            add("warn", "%s: the stream disconnected %d time(s)" % (label, c["reconnects"]),
                "See the event log for reasons (e.g. all tuners busy, network drop).")

    # ---- cross-channel pattern
    if len(chs) >= 2:
        shared = 0
        for a in chs[0]["events"]:
            if a["rf"] and all(any(b["rf"] and b["t1"] >= a["t0"] - 3 and b["t0"] <= a["t1"] + 3 for b in c["events"]) for c in chs[1:]):
                shared += 1
        total_rf = max(len(c["events"]) for c in chs) if chs else 0
        if shared:
            add("warn", "%d signal dip(s) hit ALL monitored channels at the same time" % shared,
                "Simultaneous drops on different channels point to a common cause: the antenna, cable, power/interference, or the tuner - "
                "not one TV station.")
        elif tot_rf:
            add("info", "Signal dips on one channel did not appear on the others",
                "Channel-specific dips often mean that particular station's transmitter or its frequency (interference on that channel only).")
    if any(c["dvr_seconds"] for c in chs):
        add("info", "The HDHomeRun's own DVR was recording during part of this session",
            "That is fine, but it means more tuners were busy at the time (and a recording being written can briefly add load).")
    if link == "Wi-Fi":
        add("info", "This computer was connected to the network by Wi-Fi",
            "Stream-loss measurements include the Wi-Fi hop. A wired connection gives the cleanest result.")
    return F


def _dur(s):
    s = int(s)
    if s < 120:
        return "%d seconds" % s
    if s < 7200:
        return "%d minutes" % round(s / 60)
    return "%.1f hours" % (s / 3600.0)


# --------------------------------------------------------------------------- HTTP
MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json"}


class Handler(BaseHTTPRequestHandler):
    server_version = "HDHRMonitor/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        if os.environ.get("HDHR_VERBOSE"):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % a))

    # security: only answer requests addressed to localhost (stops DNS-rebinding), and only accept POSTs from our own page
    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        return host in ("localhost", "127.0.0.1", "[::1]")

    def _origin_ok(self):
        o = self.headers.get("Origin")
        if not o:
            return True
        h = urlparse(o).hostname or ""
        return h in ("localhost", "127.0.0.1", "::1")

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _err(self, code, msg):
        self._send(code, {"error": msg})

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 100000:
            raise ValueError("body too large")
        raw = self.rfile.read(n) if n else b"{}"
        return json.loads(raw or b"{}")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            return self._err(403, "forbidden")
        try:
            u = urlparse(self.path)
            p = unquote(u.path)
            if p.startswith("/api/"):
                return self._api_get(p, parse_qs(u.query))
            return self._static(p)
        except BrokenPipeError:
            pass
        except Exception as e:
            self._err(500, "%s: %s" % (type(e).__name__, e))

    def do_POST(self):
        if not self._host_ok() or not self._origin_ok():
            return self._err(403, "forbidden")
        try:
            return self._api_post(unquote(urlparse(self.path).path), self._body())
        except BrokenPipeError:
            pass
        except RuntimeError as e:
            self._err(409, str(e))
        except Exception as e:
            self._err(500, "%s: %s" % (type(e).__name__, e))

    def _static(self, p):
        if p in ("", "/"):
            p = "/index.html"
        full = os.path.realpath(os.path.join(STATIC_DIR, p.lstrip("/")))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            return self._err(404, "not found")
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, MIME.get(os.path.splitext(full)[1], "application/octet-stream"))

    # ---- GET API
    def _api_get(self, p, q):
        if p == "/api/live":
            status, err = DEVICE.status(0.8) if DEVICE.ip else (None, "No HDHomeRun selected")
            tuners = []
            for e in status or []:
                if e.get("Resource", "").startswith("tuner") or e.get("Resource") == "record":
                    tuners.append({k: e.get(k) for k in ("Resource", "VctNumber", "VctName", "Frequency", "SignalStrengthPercent",
                                                         "SignalQualityPercent", "SymbolQualityPercent", "NetworkRate", "TargetIP", "Name")})
            return self._send(200, {"now": now(), "device": {"ip": DEVICE.ip, "ok": status is not None, "error": err, **DEVICE.info},
                                    "tuners": tuners, "rec": REC.public_state()})
        if p == "/api/lineup":
            if not DEVICE.ip:
                return self._err(409, "No HDHomeRun selected")
            return self._send(200, {"channels": DEVICE.lineup()})
        if p == "/api/discover":
            return self._send(200, {"devices": discover_devices()})
        if p == "/api/sessions":
            return self._send(200, {"sessions": list_sessions()})
        m = re.match(r"^/api/sessions/([^/]+)(/csv)?$", p)
        if m:
            sid = m.group(1)
            if not safe_sid(sid):
                return self._err(404, "no such recording")
            if m.group(2):
                with open(os.path.join(SESS_DIR, sid, "samples.csv"), "rb") as f:
                    return self._send(200, f.read(), "text/csv", {"Content-Disposition": 'attachment; filename="%s.csv"' % sid})
            meta, cols, events = load_session(sid)
            res = analyze_session(meta, cols, events)
            res.update({"meta": meta, "series": cols, "events": events})
            return self._send(200, res)
        return self._err(404, "unknown endpoint")

    # ---- POST API
    def _api_post(self, p, b):
        if p == "/api/device":
            ip = str(b.get("ip", "")).strip()
            if not valid_host(ip):
                return self._err(400, "That doesn't look like an IP address or name")
            if REC.active:
                return self._err(409, "Stop the recording before changing the device")
            old = DEVICE.ip
            DEVICE.set_ip(ip)
            try:
                DEVICE.refresh_info()
            except Exception as e:
                DEVICE.set_ip(old)
                return self._err(400, "Couldn't reach an HDHomeRun at %s (%s)" % (ip, e))
            cfg = load_config()
            cfg["device_ip"] = ip
            save_config(cfg)
            return self._send(200, {"ok": True, "device": DEVICE.info})
        if p == "/api/record/start":
            chs = [str(c) for c in b.get("channels", []) if valid_channel(str(c))]
            hours = float(b.get("hours") or 0)
            sid = REC.start(chs, str(b.get("label", "")), max(0, min(hours, 72)))
            return self._send(200, {"ok": True, "id": sid})
        if p == "/api/record/stop":
            sid = REC.stop("Stopped by user")
            return self._send(200, {"ok": True, "id": sid})
        if p == "/api/marker":
            kind = b.get("kind") if b.get("kind") in ("pixelation", "freeze", "audio", "other") else "pixelation"
            ch = str(b.get("ch", "")) if valid_channel(str(b.get("ch", ""))) else ""
            REC.add_marker(kind, ch, str(b.get("note", ""))[:200])
            return self._send(200, {"ok": True})
        m = re.match(r"^/api/sessions/([^/]+)/(delete|rename)$", p)
        if m:
            sid = m.group(1)
            if not safe_sid(sid) or (REC.active and REC.sid == sid):
                return self._err(409, "That recording can't be changed right now")
            d = os.path.join(SESS_DIR, sid)
            if m.group(2) == "delete":
                import shutil
                shutil.rmtree(d)
            else:
                with open(os.path.join(d, "meta.json")) as f:
                    meta = json.load(f)
                meta["label"] = str(b.get("label", ""))[:80]
                with open(os.path.join(d, "meta.json"), "w") as f:
                    json.dump(meta, f, indent=1)
            return self._send(200, {"ok": True})
        return self._err(404, "unknown endpoint")


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="HDHomeRun Signal Monitor")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--device", help="HDHomeRun IP address (otherwise it is auto-discovered or taken from the last run)")
    ap.add_argument("--open", action="store_true", help="open the page in the default browser")
    a = ap.parse_args()
    ensure_dirs()

    cfg = load_config()
    ip = a.device or cfg.get("device_ip")
    if not ip:
        print("Looking for an HDHomeRun on your network ...")
        devs = discover_devices(2.0)
        ip = devs[0]["ip"] if devs else None
    if ip:
        DEVICE.set_ip(ip)
        try:
            DEVICE.refresh_info()
            cfg["device_ip"] = ip
            save_config(cfg)
            print("HDHomeRun: %s at %s" % (DEVICE.info.get("FriendlyName"), ip))
        except Exception as e:
            print("Warning: could not reach the HDHomeRun at %s (%s). You can change it in the web page." % (ip, e))
    else:
        print("No HDHomeRun found automatically. You can enter its IP address in the web page.")

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    except OSError as e:
        sys.exit("Can't start on port %d (%s). Is the monitor already running? Try: http://localhost:%d" % (a.port, e, a.port))
    httpd.daemon_threads = True
    url = "http://localhost:%d" % a.port
    print("\nHDHomeRun Signal Monitor is running.\n  Open Safari and go to:  %s\n  (Leave this window open. Press Ctrl+C to quit.)\n" % url)

    def shutdown(*_):
        print("\nShutting down ...")
        REC.stop("Server stopped")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    if a.open:
        try:
            subprocess.Popen(["open", "-a", "Safari", url])
        except Exception:
            pass
    httpd.serve_forever()
    httpd.server_close()


if __name__ == "__main__":
    main()
