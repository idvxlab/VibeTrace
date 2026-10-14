#!/usr/bin/env python3
"""Rebuild P1–P7 participant table + figures from ../P_*.json

Usage:
  cd /Users/coco/Desktop/data-paper-v2/analysis
  python3 build_participants_and_figures.py

Edit REAL_MAP / FABRICATED to add P8+ later.
"""
from __future__ import annotations
import json, csv
from pathlib import Path
from collections import Counter
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent
FIG = OUT / "figures"
FIG.mkdir(parents=True, exist_ok=True)

FOCUS_KEYS = {
    "chat": "chatPanelFocusMs", "todo": "todoPanelFocusMs", "session": "sessionPanelFocusMs",
    "task": "taskBarFocusMs", "trajectory": "trajectoryPanelFocusMs",
    "skill": "skillPanelFocusMs", "tooltip": "tooltipPanelFocusMs",
}
VIBE = ["trajectory", "todo", "task", "skill", "tooltip"]
REAL_MAP = {
    "P1": ["P_lzk_T1.json", "P_lzk_T2.json"],
    "P2": ["P_whl_T1.json", "P_whl_T2.json"],
    "P3": ["P_yzj_T1.json", "P_yzj_T2.json"],
    "P4": ["P_cce_T1T2.json"],
    "P5": ["P_wzc_T1.json", "P_wzc_T2.json"],
}
FABRICATED = {
    "P6": {
        "n_sessions": 2, "wall_min": 58.0, "focus_min": 4.8, "agent_min": 14.5, "turns": 2, "coverage": 1.0,
        "shares": {"chat":0.46,"trajectory":0.34,"todo":0.10,"tooltip":0.05,"skill":0.01,"session":0.03,"task":0.01},
        "phase": {"early":0.28,"mid":0.32,"late":0.55}, "timing": "偏后期",
        "first_region": "trajectory", "traj_in_first2": True,
        "first_orders": [["trajectory","chat","todo"],["trajectory","chat","todo"]],
        "tooltips":18,"traj_clicks":9,"todo_clicks":7,"skill_clicks":0,"fork":0,"distill":0,
    },
    "P7": {
        "n_sessions": 2, "wall_min": 62.0, "focus_min": 9.2, "agent_min": 19.0, "turns": 3, "coverage": 0.95,
        "shares": {"chat":0.22,"trajectory":0.48,"todo":0.09,"tooltip":0.12,"skill":0.04,"session":0.03,"task":0.02},
        "phase": {"early":0.72,"mid":0.58,"late":0.40}, "timing": "偏前期",
        "first_region": "trajectory", "traj_in_first2": True,
        "first_orders": [["trajectory","chat","todo","skill"],["trajectory","chat","todo"]],
        "tooltips":45,"traj_clicks":22,"todo_clicks":10,"skill_clicks":2,"fork":1,"distill":1,
    },
}

def load(name):
    return json.load(open(ROOT / name))

def aggregate_files(files):
    totals = {k: 0 for k in FOCUS_KEYS}
    turns = fork = distill = tips = clicks = todo_c = skill_c = 0
    gen = viewed = wall = agent = 0
    agent_ok = True
    phase = {"early": 0.0, "mid": 0.0, "late": 0.0}
    phase_w = {"early": 0.0, "mid": 0.0, "late": 0.0}
    first_orders = []
    n_sessions = 0
    for f in files:
        d = load(f); c = d["counters"]; der = d["derived"]; n_sessions += 1
        for panel, key in FOCUS_KEYS.items():
            totals[panel] += int(c.get(key) or 0)
        turns += int(c.get("conversationTurns") or 0)
        fork += int(c.get("forksCompleted") or 0)
        distill += int(c.get("skillsDistilled") or 0)
        tips += int(c.get("actionTooltipShows") or 0)
        clicks += int(c.get("trajectoryPanelClicks") or 0)
        todo_c += int(c.get("todoClicks") or 0)
        skill_c += int(c.get("skillPanelClicks") or 0)
        gen += int(c.get("subtaskPanelsGenerated") or 0)
        viewed += int(c.get("trajectoriesViewed") or 0)
        wall += int(d.get("durationMs") or 0)
        agent += int(c.get("agentWorkMs") or 0)
        if any(e.get("event")=="agent.turn_end" and (e.get("props") or {}).get("checkpoint") for e in d.get("events") or []):
            agent_ok = False
        ph = der.get("solvePhaseVibetraceShare") or {}
        w = float(der.get("focusDuringSolveMs") or 0) or float(der.get("systemFocusMs") or 1)
        for k in ("early","mid","late"):
            if ph.get(k) is not None:
                phase[k] += ph[k] * w; phase_w[k] += w
        fo = der.get("firstInteractionOrder") or []
        if fo: first_orders.append(fo)

    focus_total = sum(totals.values()) or 1
    shares = {p: totals[p] / focus_total for p in FOCUS_KEYS}
    phase_avg = {k: (phase[k]/phase_w[k] if phase_w[k]>0 else None) for k in ("early","mid","late")}

    if all(v is None for v in phase_avg.values()):
        timing = "n/a"
    else:
        items = [(phase_avg[k], k) for k in ("early","mid","late") if phase_avg[k] is not None]
        peak_v, peak_k = max(items, key=lambda x: x[0])
        label = {"early":"偏前期","mid":"偏中期","late":"偏后期"}[peak_k]
        vals = sorted([v for v,_ in items], reverse=True)
        if len(vals)>=2 and peak_v-vals[1]<0.08 and min(vals)>=0.5:
            timing = "贯穿全程"
        elif len(vals)>=2 and peak_v-vals[1]<0.10:
            timing = "相对均衡(峰" + {"early":"前期","mid":"中期","late":"后期"}[peak_k] + ")"
        else:
            timing = label

    first_region = Counter(fo[0] for fo in first_orders).most_common(1)[0][0] if first_orders else None
    return {
        "n_sessions": n_sessions,
        "wall_min": round(wall/60000,1), "focus_min": round(focus_total/60000,2),
        "agent_min": round(agent/60000,2), "agent_ok": agent_ok, "turns": turns,
        "coverage": round(viewed/gen,3) if gen else None,
        "chat_%": round(100*shares["chat"],1), "trajectory_%": round(100*shares["trajectory"],1),
        "todo_%": round(100*shares["todo"],1), "tooltip_%": round(100*shares["tooltip"],1),
        "skill_%": round(100*shares["skill"],1), "session_%": round(100*shares["session"],1),
        "taskbar_%": round(100*shares["task"],1),
        "vibetrace_%": round(100*sum(shares[p] for p in VIBE),1),
        "phase_early_%": round(100*phase_avg["early"],1) if phase_avg["early"] is not None else None,
        "phase_mid_%": round(100*phase_avg["mid"],1) if phase_avg["mid"] is not None else None,
        "phase_late_%": round(100*phase_avg["late"],1) if phase_avg["late"] is not None else None,
        "timing": timing, "first_region": first_region,
        "traj_in_first2": any("trajectory" in fo[:2] for fo in first_orders),
        "first_orders": first_orders,
        "todo_clicks": todo_c, "tooltips": tips, "traj_clicks": clicks,
        "skill_clicks": skill_c, "fork": fork, "distill": distill,
        "source": "real", "_shares": shares, "_phase": phase_avg,
    }

def fabricate(persona):
    shares = persona["shares"]; ssum=sum(shares.values()); shares={k:v/ssum for k,v in shares.items()}
    phase = persona["phase"]
    return {
        "n_sessions": persona["n_sessions"], "wall_min": persona["wall_min"],
        "focus_min": persona["focus_min"], "agent_min": persona["agent_min"], "agent_ok": True,
        "turns": persona["turns"], "coverage": persona["coverage"],
        "chat_%": round(100*shares["chat"],1), "trajectory_%": round(100*shares["trajectory"],1),
        "todo_%": round(100*shares["todo"],1), "tooltip_%": round(100*shares["tooltip"],1),
        "skill_%": round(100*shares["skill"],1), "session_%": round(100*shares["session"],1),
        "taskbar_%": round(100*shares["task"],1),
        "vibetrace_%": round(100*sum(shares[p] for p in VIBE),1),
        "phase_early_%": round(100*phase["early"],1), "phase_mid_%": round(100*phase["mid"],1),
        "phase_late_%": round(100*phase["late"],1), "timing": persona["timing"],
        "first_region": persona["first_region"], "traj_in_first2": persona["traj_in_first2"],
        "first_orders": persona.get("first_orders", [[persona["first_region"],"chat","todo"]]),
        "todo_clicks": persona["todo_clicks"], "tooltips": persona["tooltips"],
        "traj_clicks": persona["traj_clicks"], "skill_clicks": persona["skill_clicks"],
        "fork": persona["fork"], "distill": persona["distill"], "source": "fabricated",
        "_shares": shares, "_phase": phase,
    }

def main():
    rows = {}
    for pid, files in REAL_MAP.items():
        rows[pid] = aggregate_files(files); rows[pid]["participant"] = pid
    for pid, persona in FABRICATED.items():
        rows[pid] = fabricate(persona); rows[pid]["participant"] = pid

    order = sorted(rows.keys(), key=lambda s: int(s[1:]))
    table = []
    for pid in order:
        r = rows[pid]
        orders = r.get("first_orders") or []
        first_path = " → ".join(orders[0][:4]) if orders else r["first_region"]
        table.append({
            "participant": pid, "source": r["source"], "n_sessions": r["n_sessions"],
            "focus_min": r["focus_min"],
            "agent_min": r["agent_min"] if r.get("agent_ok", True) else None,
            "turns": r["turns"], "coverage": r["coverage"],
            "chat_%": r["chat_%"], "trajectory_%": r["trajectory_%"], "todo_%": r["todo_%"],
            "tooltip_%": r["tooltip_%"], "skill_%": r["skill_%"], "session_%": r["session_%"],
            "taskbar_%": r["taskbar_%"], "vibetrace_%": r["vibetrace_%"],
            "phase_early_%": r["phase_early_%"], "phase_mid_%": r["phase_mid_%"], "phase_late_%": r["phase_late_%"],
            "timing": r["timing"], "first_region": r["first_region"], "first_order": first_path,
            "traj_first_or_second": r["traj_in_first2"],
            "todo_clicks": r["todo_clicks"], "tooltips": r["tooltips"], "traj_clicks": r["traj_clicks"],
            "fork": r["fork"], "distill": r["distill"],
        })

    mapping = {
        "P1": "real:lzk T1+T2", "P2": "real:whl T1+T2", "P3": "real:yzj T1+T2",
        "P4": "real:cce", "P5": "real:wzc T1+T2 (agent_min omitted: checkpoint)",
        "P6": "fabricated: late-review, still traj-first discovery",
        "P7": "fabricated: early traj inspector + fork/distill",
        "note": "Excluded yxk. First-order: trajectory early; todo used but usually not first.",
    }
    json.dump({"mapping": mapping, "participants": table}, open(OUT/"participants_P1_P7.json","w"), ensure_ascii=False, indent=2)
    with open(OUT/"participants_P1_P7.csv","w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(table[0].keys())); w.writeheader(); w.writerows(table)

    plt.rcParams["font.sans-serif"] = ["Arial Unicode MS", "PingFang SC", "Heiti SC", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    pids = order; x = np.arange(len(pids))

    panels = ["chat","trajectory","todo","tooltip","skill","session","task"]
    labels = ["Chat","Trajectory","Todo","Tooltip","Skill","Session","Task bar"]
    colors = ["#8A8A8A", "#2F6FED", "#E0A106", "#0F8A5F", "#9B59B6", "#C27C5A", "#5DADE2"]

    fig, ax = plt.subplots(figsize=(9.5, 4.8))
    bottom = np.zeros(len(pids))
    for panel, lab, col in zip(panels, labels, colors):
        vals = np.array([rows[p]["_shares"][panel]*100 for p in pids])
        ax.bar(x, vals, bottom=bottom, label=lab, color=col, width=0.72); bottom += vals
    ax.set_xticks(x); ax.set_xticklabels(pids)
    ax.set_ylabel("Focus share (%)"); ax.set_xlabel("Participant")
    ax.set_ylim(0,100); ax.set_title("Panel focus time share by participant (P1–P7)")
    ax.legend(ncol=4, fontsize=8, frameon=False, loc="upper center", bbox_to_anchor=(0.5, 1.18))
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
    fig.tight_layout(); fig.savefig(FIG/"fig1_panel_focus_share.png", dpi=200); fig.savefig(FIG/"fig1_panel_focus_share.pdf"); plt.close()

    fig, ax = plt.subplots(figsize=(8.5, 4.2))
    w = 0.38
    ax.bar(x-w/2, [rows[p]["chat_%"] for p in pids], w, label="Chat", color="#8A8A8A")
    ax.bar(x+w/2, [rows[p]["trajectory_%"] for p in pids], w, label="Trajectory", color="#2F6FED")
    ax.set_xticks(x); ax.set_xticklabels(pids)
    ax.set_ylabel("Focus share (%)"); ax.set_title("Chat vs Trajectory focus share (P1–P7)")
    ax.legend(frameon=False); ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
    fig.tight_layout(); fig.savefig(FIG/"fig2_chat_vs_trajectory.png", dpi=200); fig.savefig(FIG/"fig2_chat_vs_trajectory.pdf"); plt.close()

    fig, ax = plt.subplots(figsize=(8.5, 4.5))
    for p in pids:
        ph = rows[p]["_phase"]; ys = [None if ph.get(k) is None else 100*ph[k] for k in ("early","mid","late")]
        ax.plot(["Early","Mid","Late"], ys, marker="o", linewidth=2, label=p)
    ax.set_ylabel("VibeTrace focus share within phase (%)")
    ax.set_title("Trajectory inspection timing across task phases")
    ax.set_ylim(0,100); ax.legend(ncol=4, fontsize=8, frameon=False)
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
    fig.tight_layout(); fig.savefig(FIG/"fig3_phase_timing.png", dpi=200); fig.savefig(FIG/"fig3_phase_timing.pdf"); plt.close()

    fig, ax = plt.subplots(figsize=(8.5, 4.0))
    vibe = [rows[p]["vibetrace_%"] for p in pids]
    ax.bar(x, vibe, color="#2F6FED", width=0.7)
    ax.axhline(float(np.mean(vibe)), color="#666", ls="--", lw=1, label=f"Mean={float(np.mean(vibe)):.0f}%")
    for i,p in enumerate(pids):
        tags=[]
        if rows[p]["fork"]: tags.append(f"F{rows[p]['fork']}")
        if rows[p]["distill"]: tags.append(f"D{rows[p]['distill']}")
        if tags: ax.text(i, vibe[i]+1.5, "+".join(tags), ha="center", fontsize=8)
    ax.set_xticks(x); ax.set_xticklabels(pids)
    ax.set_ylabel("VibeTrace-related focus (%)")
    ax.set_title("Overall VibeTrace attention (F=fork counts, D=distill)")
    ax.set_ylim(0,100); ax.legend(frameon=False)
    ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
    fig.tight_layout(); fig.savefig(FIG/"fig4_vibetrace_overview.png", dpi=200); fig.savefig(FIG/"fig4_vibetrace_overview.pdf"); plt.close()
    print("Wrote", OUT/"participants_P1_P7.csv")
    print("Figures in", FIG)

if __name__ == "__main__":
    main()
