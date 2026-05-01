import { useState, useCallback, useRef } from "react";

const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ── XIRR ─────────────────────────────────────────────────────────────────────
function xirr(cashflows) {
  if (cashflows.length < 2) return null;
  const sorted = [...cashflows].sort((a, b) => new Date(a.date) - new Date(b.date));
  const t0 = new Date(sorted[0].date).getTime();
  const years = sorted.map(cf => (new Date(cf.date).getTime() - t0) / (365.25 * 24 * 3600 * 1000));
  const amounts = sorted.map(cf => cf.amount);
  const npv = r => amounts.reduce((s, a, i) => s + a / Math.pow(1 + r, years[i]), 0);
  const dnpv = r => amounts.reduce((s, a, i) => s - (years[i] * a) / Math.pow(1 + r, years[i] + 1), 0);
  let rate = 0.1;
  for (let i = 0; i < 100; i++) {
    const v = npv(rate), dv = dnpv(rate);
    if (Math.abs(v) < 1e-7 || dv === 0) break;
    rate -= v / dv;
    if (rate <= -1) rate = -0.999;
  }
  return !isFinite(rate) || isNaN(rate) ? null : rate;
}

// ── CAS PARSER ────────────────────────────────────────────────────────────────
function parseCASText(fullText) {
  const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);
  const result = { pans: {}, statementPeriod: "" };
  const periodMatch = fullText.match(/Period\s*[:\-]\s*(\d{2}[\/\-]\w+[\/\-]\d{4})\s*[Tt]o\s*(\d{2}[\/\-]\w+[\/\-]\d{4})/);
  if (periodMatch) result.statementPeriod = `${periodMatch[1]} to ${periodMatch[2]}`;

  let currentPAN = null, currentFolio = null, currentScheme = null, currentISIN = null, inTxns = false;
  const panRe = /PAN\s*[:\-]?\s*([A-Z]{5}[0-9]{4}[A-Z])/i;
  const folioRe = /Folio\s*(?:No\.?)?\s*[:\-]?\s*([\w\/\-]+)/i;
  const isinRe = /ISIN\s*[:\-]?\s*([A-Z]{2}[A-Z0-9]{10})/i;
  const txnRe = /^(\d{2}[-\/]\w{3}[-\/]\d{4})\s+([\w\s\/\(\)\-]+?)\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+([\d,]+\.\d+)\s*([CD]?)/i;
  const closingRe = /Closing\s+Unit\s+Balance\s*[:\-]?\s*([\d,]+\.\d+)/i;
  const navClosingRe = /NAV\s+on\s+[\w\s,]+\s*[:\-]?\s*(?:INR\s*)?([\d,]+\.\d+)/i;
  const parseNum = s => parseFloat((s || "0").replace(/,/g, ""));
  const parseDate = s => {
    if (!s) return null;
    const parts = s.replace(/-/g, "/").split("/");
    const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
    const d = parseInt(parts[0]), m = isNaN(parseInt(parts[1])) ? months[parts[1]] : parseInt(parts[1]) - 1, y = parseInt(parts[2]);
    return new Date(y, m, d);
  };
  const ensurePAN = p => { if (!result.pans[p]) result.pans[p] = { folios: {} }; return result.pans[p]; };
  const ensureFolio = (p, f) => { const pan = ensurePAN(p); if (!pan.folios[f]) pan.folios[f] = { schemes: {} }; return pan.folios[f]; };
  const ensureScheme = (p, f, isin, name) => { const folio = ensureFolio(p, f); if (!folio.schemes[isin]) folio.schemes[isin] = { isin, name, transactions: [], closingUnits: 0, closingNAV: 0 }; return folio.schemes[isin]; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const panM = line.match(panRe);
    if (panM) { currentPAN = panM[1].toUpperCase(); continue; }
    const folioM = line.match(folioRe);
    if (folioM && currentPAN) { currentFolio = folioM[1].trim(); inTxns = false; continue; }
    const isinM = line.match(isinRe);
    if (isinM) {
      currentISIN = isinM[1];
      const namePart = line.replace(isinRe, "").replace(/ISIN\s*[:\-]?\s*/i, "").trim();
      currentScheme = namePart.length > 3 ? namePart : (i > 0 ? lines[i - 1].replace(/^Scheme\s*[:\-]?\s*/i, "").trim() : "");
      inTxns = true; continue;
    }
    const closM = line.match(closingRe);
    if (closM && currentPAN && currentFolio && currentISIN) { ensureScheme(currentPAN, currentFolio, currentISIN, currentScheme).closingUnits = parseNum(closM[1]); continue; }
    const navM = line.match(navClosingRe);
    if (navM && currentPAN && currentFolio && currentISIN) { ensureScheme(currentPAN, currentFolio, currentISIN, currentScheme).closingNAV = parseNum(navM[1]); continue; }
    if (inTxns && currentPAN && currentFolio && currentISIN) {
      const txnM = line.match(txnRe);
      if (txnM) {
        const date = parseDate(txnM[1]);
        const desc = txnM[2].trim();
        const side = txnM[6] ? txnM[6].toUpperCase() : (desc.toLowerCase().includes("redempt") ? "D" : "C");
        ensureScheme(currentPAN, currentFolio, currentISIN, currentScheme).transactions.push({
          date: date ? date.toISOString().split("T")[0] : txnM[1],
          description: desc, amount: parseNum(txnM[3]), units: parseNum(txnM[4]), nav: parseNum(txnM[5]),
          type: side === "D" ? "Redemption" : desc.toLowerCase().includes("dividend") ? "Dividend" : "Purchase",
        });
      }
    }
  }
  return result;
}

// ── METRICS ───────────────────────────────────────────────────────────────────
function calcMetrics(schemes) {
  const today = new Date().toISOString().split("T")[0];
  let totalInvested = 0, totalCurrentValue = 0;
  const portfolioCFs = [];

  const schemeMetrics = schemes.map(s => {
    const buys = s.transactions.filter(t => t.type === "Purchase");
    const sells = s.transactions.filter(t => t.type === "Redemption");
    const invested = buys.reduce((sum, t) => sum + t.amount, 0);
    const redeemed = sells.reduce((sum, t) => sum + t.amount, 0);
    const netInvested = invested - redeemed;
    const currentValue = s.closingUnits * s.closingNAV;
    const absReturn = netInvested > 0 ? ((currentValue - netInvested) / netInvested) * 100 : 0;
    const cfs = [...buys.map(t => ({ date: t.date, amount: -t.amount })), ...sells.map(t => ({ date: t.date, amount: t.amount }))];
    if (currentValue > 0) cfs.push({ date: today, amount: currentValue });
    const xirrRate = xirr(cfs);
    totalInvested += netInvested;
    totalCurrentValue += currentValue;
    portfolioCFs.push(...cfs.filter(cf => cf.date !== today));
    const gains = { stcg: 0, ltcg: 0 };
    const lots = buys.map(t => ({ ...t, remaining: t.units }));
    for (const sell of sells) {
      let toSell = sell.units;
      for (const lot of lots) {
        if (toSell <= 0 || lot.remaining <= 0) continue;
        const used = Math.min(lot.remaining, toSell);
        const gain = used * (sell.nav - lot.nav);
        const days = (new Date(sell.date) - new Date(lot.date)) / (1000 * 3600 * 24);
        if (days < 365) gains.stcg += gain; else gains.ltcg += gain;
        lot.remaining -= used; toSell -= used;
      }
    }
    return { ...s, invested, redeemed, netInvested, currentValue, absReturn, xirr: xirrRate !== null ? xirrRate * 100 : null, gains, avgCostNav: s.closingUnits > 0 ? netInvested / s.closingUnits : 0 };
  });

  if (totalCurrentValue > 0) portfolioCFs.push({ date: today, amount: totalCurrentValue });
  const portfolioXIRR = xirr(portfolioCFs);
  const totalAbsReturn = totalInvested > 0 ? ((totalCurrentValue - totalInvested) / totalInvested) * 100 : 0;
  return { schemeMetrics, totalInvested, totalCurrentValue, totalAbsReturn, portfolioXIRR: portfolioXIRR !== null ? portfolioXIRR * 100 : null };
}

function buildSchemesForPANs(casData, selectedPANs) {
  const byISIN = {};
  for (const pan of selectedPANs) {
    const panData = casData.pans[pan];
    if (!panData) continue;
    for (const [folioId, folio] of Object.entries(panData.folios)) {
      for (const [isin, scheme] of Object.entries(folio.schemes)) {
        if (!byISIN[isin]) byISIN[isin] = { isin, name: scheme.name, transactions: [], closingUnits: 0, closingNAV: scheme.closingNAV, panBreakdown: {} };
        byISIN[isin].transactions.push(...scheme.transactions.map(t => ({ ...t, folio: folioId, pan })));
        byISIN[isin].closingUnits += scheme.closingUnits;
        if (!byISIN[isin].panBreakdown[pan]) byISIN[isin].panBreakdown[pan] = { transactions: [], closingUnits: 0, closingNAV: scheme.closingNAV };
        byISIN[isin].panBreakdown[pan].transactions.push(...scheme.transactions.map(t => ({ ...t, folio: folioId })));
        byISIN[isin].panBreakdown[pan].closingUnits += scheme.closingUnits;
      }
    }
  }
  return Object.values(byISIN);
}

function calcSchemePerPAN(panBreakdown) {
  const result = {};
  for (const [pan, data] of Object.entries(panBreakdown)) {
    const metrics = calcMetrics([{ isin: "", name: "", transactions: data.transactions, closingUnits: data.closingUnits, closingNAV: data.closingNAV }]);
    result[pan] = metrics.schemeMetrics[0];
  }
  return result;
}

// ── DEMO DATA ─────────────────────────────────────────────────────────────────
function getDemoData() {
  return {
    statementPeriod: "01/Apr/2023 to 31/Mar/2024",
    pans: {
      "ABCDE1234F": {
        folios: {
          "1234567/89": {
            schemes: {
              "INF109K01VQ1": { isin: "INF109K01VQ1", name: "Axis Bluechip Fund – Direct Growth", closingUnits: 245.678, closingNAV: 52.34,
                transactions: [
                  { date: "2023-04-05", description: "SIP Purchase", amount: 5000, units: 105.234, nav: 47.51, type: "Purchase" },
                  { date: "2023-07-05", description: "SIP Purchase", amount: 5000, units: 99.206, nav: 50.40, type: "Purchase" },
                  { date: "2023-10-05", description: "SIP Purchase", amount: 5000, units: 98.425, nav: 50.80, type: "Purchase" },
                  { date: "2024-01-05", description: "SIP Purchase", amount: 5000, units: 97.847, nav: 51.10, type: "Purchase" },
                  { date: "2024-02-15", description: "Redemption", amount: 5200, units: 99.234, nav: 52.40, type: "Redemption" },
                ]},
              "INF174K01LS2": { isin: "INF174K01LS2", name: "Kotak Flexi Cap Fund – Direct Growth", closingUnits: 312.450, closingNAV: 68.90,
                transactions: [
                  { date: "2023-05-10", description: "Lumpsum Purchase", amount: 10000, units: 154.320, nav: 64.80, type: "Purchase" },
                  { date: "2023-11-10", description: "SIP Purchase", amount: 5000, units: 74.960, nav: 66.70, type: "Purchase" },
                  { date: "2024-02-10", description: "SIP Purchase", amount: 5000, units: 73.170, nav: 68.34, type: "Purchase" },
                ]},
            }
          },
          "9876543/21": {
            schemes: {
              "INF109K01VQ1": { isin: "INF109K01VQ1", name: "Axis Bluechip Fund – Direct Growth", closingUnits: 88.123, closingNAV: 52.34,
                transactions: [
                  { date: "2023-06-15", description: "Lumpsum Purchase", amount: 4500, units: 88.123, nav: 51.07, type: "Purchase" },
                ]},
            }
          }
        }
      },
      "XYZPQ5678G": {
        folios: {
          "5544332/10": {
            schemes: {
              "INF200K01RB2": { isin: "INF200K01RB2", name: "SBI Nifty Index Fund – Direct Growth", closingUnits: 520.000, closingNAV: 198.45,
                transactions: [
                  { date: "2023-04-01", description: "SIP Purchase", amount: 10000, units: 52.910, nav: 189.00, type: "Purchase" },
                  { date: "2023-07-01", description: "SIP Purchase", amount: 10000, units: 51.710, nav: 193.40, type: "Purchase" },
                  { date: "2023-10-01", description: "SIP Purchase", amount: 10000, units: 51.390, nav: 194.60, type: "Purchase" },
                  { date: "2024-01-01", description: "SIP Purchase", amount: 10000, units: 50.890, nav: 196.50, type: "Purchase" },
                  { date: "2024-01-25", description: "Redemption", amount: 9800, units: 49.380, nav: 198.45, type: "Redemption" },
                  { date: "2024-03-01", description: "IDCW/Dividend", amount: 850, units: 0, nav: 0, type: "Dividend" },
                ]},
              "INF109K01VQ1": { isin: "INF109K01VQ1", name: "Axis Bluechip Fund – Direct Growth", closingUnits: 60.000, closingNAV: 52.34,
                transactions: [
                  { date: "2023-08-10", description: "Lumpsum Purchase", amount: 3000, units: 60.000, nav: 50.00, type: "Purchase" },
                ]},
            }
          }
        }
      }
    }
  };
}

// ── DESIGN TOKENS ─────────────────────────────────────────────────────────────
const C = {
  bg: "#f4f6f9",
  surface: "#ffffff",
  surfaceHover: "#f8f9fb",
  border: "#e5e7eb",
  borderStrong: "#d1d5db",
  text: "#111827",
  textSecondary: "#6b7280",
  textMuted: "#9ca3af",
  accent: "#4f46e5",
  accentLight: "#eef2ff",
  accentBorder: "#c7d2fe",
  green: "#059669",
  greenBg: "#ecfdf5",
  red: "#dc2626",
  redBg: "#fef2f2",
  amber: "#d97706",
  amberBg: "#fffbeb",
  blue: "#2563eb",
  blueBg: "#eff6ff",
  panColors: ["#4f46e5", "#0891b2", "#7c3aed", "#0d9488", "#b45309"],
};

// ── FORMAT ────────────────────────────────────────────────────────────────────
const fmt = {
  inr: v => v == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(v),
  pct: v => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`,
  num: (v, d = 3) => v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: d }),
};

// ── UI PRIMITIVES ─────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color }) {
  const textColor = color === "green" ? C.green : color === "red" ? C.red : C.text;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "15px 18px", flex: 1, minWidth: 128, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
      <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: 600, marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: textColor, fontFamily: "'DM Mono', monospace", lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function Badge({ children, color }) {
  const map = { green: [C.green, C.greenBg], red: [C.red, C.redBg], blue: [C.blue, C.blueBg], amber: [C.amber, C.amberBg], gray: [C.textSecondary, C.bg] };
  const [fg, bg] = map[color] || map.gray;
  return <span style={{ background: bg, color: fg, border: `1px solid ${fg}33`, borderRadius: 5, padding: "2px 7px", fontSize: 11, fontWeight: 600 }}>{children}</span>;
}

function PctVal({ value }) {
  if (value == null) return <span style={{ color: C.textMuted, fontFamily: "'DM Mono', monospace", fontSize: "inherit" }}>—</span>;
  return <span style={{ color: value >= 0 ? C.green : C.red, fontFamily: "'DM Mono', monospace", fontWeight: 600, fontSize: "inherit" }}>{fmt.pct(value)}</span>;
}

function MonoVal({ value, color }) {
  return <span style={{ fontFamily: "'DM Mono', monospace", color: color || C.text, fontSize: "inherit" }}>{value}</span>;
}

// Column layout helper
const COL = { scheme: 3, cv: 1, inv: 1, pnl: 1, abs: 1, xirr: 1 };

function TableHeader({ firstCol = "Scheme" }) {
  return (
    <div style={{ display: "flex", padding: "9px 16px", background: C.bg, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: COL.scheme, fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: "0.07em", textTransform: "uppercase" }}>{firstCol}</div>
      {["Current Value", "Invested", "P&L", "Abs Return", "XIRR"].map(h => (
        <div key={h} style={{ flex: 1, textAlign: "right", fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: "0.07em", textTransform: "uppercase" }}>{h}</div>
      ))}
    </div>
  );
}

function DataRow({ label, labelEl, invested, currentValue, absReturn, xirrVal, indent, highlight, accentColor }) {
  const pnl = currentValue - invested;
  const bg = highlight ? C.accentLight : indent ? "#fafbfc" : C.surface;
  return (
    <div style={{ display: "flex", alignItems: "center", padding: indent ? "7px 16px 7px 32px" : "12px 16px", background: bg, borderBottom: `1px solid ${C.border}`, fontSize: indent ? 12 : 13 }}>
      <div style={{ flex: COL.scheme, color: accentColor || (indent ? C.textSecondary : C.text), fontWeight: indent ? 500 : 600, fontFamily: indent ? "'DM Mono', monospace" : "inherit" }}>
        {labelEl || label}
      </div>
      <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(currentValue)} /></div>
      <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(invested)} color={C.textSecondary} /></div>
      <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(pnl)} color={pnl >= 0 ? C.green : C.red} /></div>
      <div style={{ flex: 1, textAlign: "right" }}><PctVal value={absReturn} /></div>
      <div style={{ flex: 1, textAlign: "right" }}><PctVal value={xirrVal} /></div>
    </div>
  );
}

// ── PAN SELECTOR ──────────────────────────────────────────────────────────────
function PANSelector({ pans, selectedPANs, onToggle, onSelectAll, panColorMap }) {
  const allSel = selectedPANs.length === pans.length;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 10, color: C.textMuted, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginRight: 2 }}>Filter PANs</span>
      <button onClick={onSelectAll} style={{
        padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
        background: allSel ? C.accent : C.surface, color: allSel ? "#fff" : C.textSecondary,
        border: `1.5px solid ${allSel ? C.accent : C.borderStrong}`, transition: "all 0.15s",
      }}>All PANs</button>
      {pans.map(pan => {
        const sel = selectedPANs.includes(pan);
        const pc = panColorMap[pan];
        return (
          <button key={pan} onClick={() => onToggle(pan)} style={{
            padding: "5px 14px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
            fontFamily: "'DM Mono', monospace",
            background: sel ? `${pc}15` : C.surface,
            color: sel ? pc : C.textSecondary,
            border: `1.5px solid ${sel ? pc : C.borderStrong}`,
            transition: "all 0.15s",
          }}>
            {sel && <span style={{ marginRight: 5, fontSize: 10 }}>✓</span>}{pan}
          </button>
        );
      })}
    </div>
  );
}

// ── SCHEME ROW ────────────────────────────────────────────────────────────────
function SchemeRow({ s, panBreakdownMetrics, selectedPANs, panColorMap, expanded, onToggle }) {
  const gain = s.currentValue - s.netInvested;
  const showPerPAN = selectedPANs.length > 1 && Object.keys(panBreakdownMetrics).length > 1;

  return (
    <div style={{ borderBottom: `1px solid ${C.border}` }}>
      {/* Scheme summary */}
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", padding: "12px 16px", cursor: "pointer", transition: "background 0.12s", background: expanded ? "#f9fafe" : C.surface, fontSize: 13 }}
        onMouseEnter={e => { if (!expanded) e.currentTarget.style.background = C.surfaceHover; }}
        onMouseLeave={e => { if (!expanded) e.currentTarget.style.background = expanded ? "#f9fafe" : C.surface; }}>
        <div style={{ flex: "0 0 18px", color: C.textMuted, fontSize: 10, marginRight: 4 }}>{expanded ? "▾" : "▸"}</div>
        <div style={{ flex: COL.scheme }}>
          <div style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{s.name}</div>
          <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2, fontFamily: "'DM Mono', monospace" }}>{s.isin}</div>
        </div>
        <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(s.currentValue)} /></div>
        <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(s.netInvested)} color={C.textSecondary} /></div>
        <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(gain)} color={gain >= 0 ? C.green : C.red} /></div>
        <div style={{ flex: 1, textAlign: "right" }}><PctVal value={s.absReturn} /></div>
        <div style={{ flex: 1, textAlign: "right" }}><PctVal value={s.xirr} /></div>
      </div>

      {/* Per-PAN sub-rows (always shown when multiple PANs selected) */}
      {showPerPAN && Object.entries(panBreakdownMetrics).map(([pan, pm]) => {
        const pc = panColorMap[pan];
        const pg = pm.currentValue - pm.netInvested;
        return (
          <div key={pan} style={{ display: "flex", alignItems: "center", padding: "6px 16px 6px 38px", background: "#fafbfd", borderTop: `1px solid ${C.border}`, fontSize: 12 }}>
            <div style={{ flex: COL.scheme }}>
              <span style={{ color: pc, fontFamily: "'DM Mono', monospace", fontWeight: 600, fontSize: 11, background: `${pc}12`, padding: "2px 8px", borderRadius: 4, border: `1px solid ${pc}25` }}>{pan}</span>
            </div>
            <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(pm.currentValue)} color={C.textSecondary} /></div>
            <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(pm.netInvested)} color={C.textMuted} /></div>
            <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(pg)} color={pg >= 0 ? C.green : C.red} /></div>
            <div style={{ flex: 1, textAlign: "right" }}><PctVal value={pm.absReturn} /></div>
            <div style={{ flex: 1, textAlign: "right" }}><PctVal value={pm.xirr} /></div>
          </div>
        );
      })}

      {/* Expanded detail */}
      {expanded && (
        <div style={{ background: C.bg, borderTop: `1px solid ${C.border}`, padding: "16px 20px 20px 38px" }}>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <StatCard label="Closing Units" value={fmt.num(s.closingUnits)} />
            <StatCard label="Avg Cost NAV" value={`₹${fmt.num(s.avgCostNav, 2)}`} />
            <StatCard label="Current NAV" value={`₹${fmt.num(s.closingNAV, 2)}`} />
            <StatCard label="Unrealised P&L" value={fmt.inr(gain)} color={gain >= 0 ? "green" : "red"} />
            <StatCard label="STCG" value={fmt.inr(s.gains.stcg)} color={s.gains.stcg > 0 ? "red" : "green"} sub="Short-term gains" />
            <StatCard label="LTCG" value={fmt.inr(s.gains.ltcg)} color={s.gains.ltcg > 0 ? "red" : "green"} sub="Long-term gains" />
          </div>
          <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", fontWeight: 700, marginBottom: 8 }}>Transaction History</div>
          <div style={{ overflowX: "auto", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: C.bg }}>
                  {["Date", "Description", "Amount", "Units", "NAV", "Type"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "8px 12px", fontWeight: 700, color: C.textMuted, fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap", borderBottom: `1px solid ${C.border}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.transactions.map((t, i) => (
                  <tr key={i} style={{ borderTop: i > 0 ? `1px solid ${C.border}` : "none" }}
                    onMouseEnter={e => e.currentTarget.style.background = C.bg}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <td style={{ padding: "7px 12px", color: C.textSecondary, fontFamily: "'DM Mono', monospace", whiteSpace: "nowrap" }}>{t.date}</td>
                    <td style={{ padding: "7px 12px", color: C.text }}>{t.description}</td>
                    <td style={{ padding: "7px 12px", fontFamily: "'DM Mono', monospace" }}>{t.amount > 0 ? fmt.inr(t.amount) : "—"}</td>
                    <td style={{ padding: "7px 12px", fontFamily: "'DM Mono', monospace", color: C.textSecondary }}>{t.units > 0 ? fmt.num(t.units) : "—"}</td>
                    <td style={{ padding: "7px 12px", fontFamily: "'DM Mono', monospace", color: C.textSecondary }}>{t.nav > 0 ? `₹${fmt.num(t.nav, 2)}` : "—"}</td>
                    <td style={{ padding: "7px 12px" }}>
                      <Badge color={t.type === "Purchase" ? "green" : t.type === "Redemption" ? "red" : "blue"}>{t.type}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
export default function CASParser() {
  const [casData, setCasData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedSchemes, setExpandedSchemes] = useState({});
  const [selectedPANs, setSelectedPANs] = useState([]);
  const [parseLog, setParseLog] = useState([]);
  const [showPANPortfolioRows, setShowPANPortfolioRows] = useState(true);
  const dropRef = useRef(null);
  const pdfJsLoaded = useRef(false);

  const loadPdfJs = () => new Promise((res, rej) => {
    if (pdfJsLoaded.current) { res(window.pdfjsLib); return; }
    const s = document.createElement("script"); s.src = PDFJS_CDN;
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; pdfJsLoaded.current = true; res(window.pdfjsLib); };
    s.onerror = rej; document.head.appendChild(s);
  });

  const processFile = async (file) => {
    if (!file || file.type !== "application/pdf") { setError("Please upload a PDF file."); return; }
    setLoading(true); setError(null);
    try {
      const pdfjsLib = await loadPdfJs();
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let fullText = "";
      const log = [`PDF loaded: ${pdf.numPages} pages`];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        fullText += (await page.getTextContent()).items.map(it => it.str).join(" ") + "\n";
      }
      log.push(`Extracted ${fullText.length.toLocaleString()} chars`);
      const parsed = parseCASText(fullText);
      const pans = Object.keys(parsed.pans);
      log.push(`Detected ${pans.length} PAN(s)`);
      if (pans.length === 0) {
        log.push("⚠️ No PAN data found — showing demo data.");
        const demo = getDemoData(); setCasData(demo); setSelectedPANs(Object.keys(demo.pans));
      } else { setCasData(parsed); setSelectedPANs(pans); }
      setParseLog(log);
    } catch (e) { setError(`Parse error: ${e.message}`); }
    setLoading(false);
  };

  const loadDemo = () => {
    const demo = getDemoData();
    setCasData(demo); setSelectedPANs(Object.keys(demo.pans));
    setParseLog(["Demo data — 2 PANs, 3 folios, 4 schemes, Axis Bluechip shared across 3 PANs"]);
  };

  const handleDrop = useCallback(async (e) => { e.preventDefault(); e.stopPropagation(); await processFile(e.dataTransfer.files[0]); }, []);
  const handleDragOver = e => { e.preventDefault(); if (dropRef.current) { dropRef.current.style.borderColor = C.accent; dropRef.current.style.background = C.accentLight; } };
  const handleDragLeave = () => { if (dropRef.current) { dropRef.current.style.borderColor = C.accentBorder; dropRef.current.style.background = "#f0f3ff"; } };

  const allPANs = casData ? Object.keys(casData.pans) : [];
  const panColorMap = Object.fromEntries(allPANs.map((p, i) => [p, C.panColors[i % C.panColors.length]]));

  const togglePAN = pan => setSelectedPANs(prev => prev.includes(pan) ? (prev.length > 1 ? prev.filter(p => p !== pan) : prev) : [...prev, pan]);
  const selectAll = () => { if (casData) setSelectedPANs(Object.keys(casData.pans)); };

  const schemes = casData && selectedPANs.length > 0 ? buildSchemesForPANs(casData, selectedPANs) : [];
  const portfolio = schemes.length > 0 ? calcMetrics(schemes) : null;

  const perPANPortfolio = casData ? Object.fromEntries(
    selectedPANs.map(pan => [pan, calcMetrics(buildSchemesForPANs(casData, [pan]))])
  ) : {};

  const schemePerPAN = {};
  if (portfolio) {
    for (const s of schemes) schemePerPAN[s.isin] = calcSchemePerPAN(s.panBreakdown);
  }

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Inter', -apple-system, sans-serif", color: C.text }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>

      {/* Header */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "13px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, letterSpacing: "-0.02em" }}>
          CAS <span style={{ color: C.accent }}>Analyser</span>
        </div>
        {casData && (
          <PANSelector pans={allPANs} selectedPANs={selectedPANs} onToggle={togglePAN} onSelectAll={selectAll} panColorMap={panColorMap} />
        )}
        {casData && (
          <button onClick={() => { setCasData(null); setParseLog([]); setSelectedPANs([]); }} style={{ fontSize: 12, color: C.red, background: C.redBg, border: `1px solid #fca5a5`, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontWeight: 500 }}>✕ Reset</button>
        )}
        {!casData && <div style={{ fontSize: 11, color: C.textMuted }}>Multi-PAN · Multi-Folio · XIRR · Capital Gains</div>}
      </div>

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 18px" }}>

        {/* Upload */}
        {!casData && !loading && (
          <div>
            <div ref={dropRef} onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}
              style={{ border: `2px dashed ${C.accentBorder}`, borderRadius: 14, background: "#f0f3ff", padding: "52px 40px", textAlign: "center", cursor: "pointer", transition: "all 0.2s" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>📄</div>
              <div style={{ fontSize: 17, color: C.text, fontWeight: 600, marginBottom: 8 }}>Drop your CAS PDF here</div>
              <div style={{ fontSize: 13, color: C.textSecondary, marginBottom: 22 }}>Supports CAS from CAMS, KFintech (Karvy), or MF Central</div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <label style={{ background: C.accent, color: "#fff", padding: "9px 22px", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 600, boxShadow: "0 2px 8px rgba(79,70,229,0.25)" }}>
                  Choose PDF <input type="file" accept=".pdf" style={{ display: "none" }} onChange={e => processFile(e.target.files[0])} />
                </label>
                <button onClick={loadDemo} style={{ background: C.surface, color: C.textSecondary, border: `1px solid ${C.borderStrong}`, padding: "9px 22px", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Load Demo Data</button>
              </div>
            </div>
            <div style={{ textAlign: "center", marginTop: 10, fontSize: 12, color: C.textMuted }}>🔒 All processing is local — no data leaves your browser</div>
            {error && <div style={{ marginTop: 12, background: C.redBg, border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 14px", color: C.red, fontSize: 13 }}>{error}</div>}
          </div>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: 60 }}>
            <div style={{ fontSize: 28, display: "inline-block", animation: "spin 1s linear infinite", marginBottom: 12, color: C.accent }}>⟳</div>
            <div style={{ color: C.textSecondary }}>Parsing CAS PDF…</div>
          </div>
        )}

        {casData && !loading && portfolio && (
          <div>
            {/* Parse log */}
            {parseLog.length > 0 && (
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 16 }}>
                {parseLog.map((l, i) => <span key={i} style={{ fontSize: 11, color: C.textMuted, fontFamily: "'DM Mono', monospace" }}>• {l}</span>)}
                {casData.statementPeriod && <span style={{ fontSize: 11, color: C.textMuted }}>· Period: {casData.statementPeriod}</span>}
              </div>
            )}

            {/* Summary stat cards */}
            <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
              <StatCard label="Total Invested" value={fmt.inr(portfolio.totalInvested)} />
              <StatCard label="Current Value" value={fmt.inr(portfolio.totalCurrentValue)} color={portfolio.totalCurrentValue >= portfolio.totalInvested ? "green" : "red"} />
              <StatCard label="Unrealised P&L" value={fmt.inr(portfolio.totalCurrentValue - portfolio.totalInvested)} color={portfolio.totalCurrentValue >= portfolio.totalInvested ? "green" : "red"} />
              <StatCard label="Abs Return" value={fmt.pct(portfolio.totalAbsReturn)} color={portfolio.totalAbsReturn >= 0 ? "green" : "red"} sub="Total gain / loss" />
              <StatCard label="Portfolio XIRR" value={portfolio.portfolioXIRR != null ? fmt.pct(portfolio.portfolioXIRR) : "—"} color={portfolio.portfolioXIRR >= 0 ? "green" : "red"} sub="Time-weighted" />
            </div>

            {/* Portfolio summary table (combined + per-PAN rows) */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 16, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
              <TableHeader firstCol="Portfolio Overview" />
              <DataRow label="All Selected PANs" invested={portfolio.totalInvested} currentValue={portfolio.totalCurrentValue} absReturn={portfolio.totalAbsReturn} xirrVal={portfolio.portfolioXIRR} />
              {selectedPANs.length > 1 && (
                <>
                  <div onClick={() => setShowPANPortfolioRows(p => !p)}
                    style={{ padding: "6px 16px", fontSize: 11, color: C.accent, cursor: "pointer", fontWeight: 600, display: "flex", alignItems: "center", gap: 5, background: C.accentLight, borderTop: `1px solid ${C.accentBorder}` }}>
                    <span style={{ fontSize: 9 }}>{showPANPortfolioRows ? "▾" : "▸"}</span> PAN-wise breakdown
                  </div>
                  {showPANPortfolioRows && selectedPANs.map(pan => {
                    const pp = perPANPortfolio[pan];
                    return (
                      <DataRow key={pan}
                        labelEl={<span style={{ color: panColorMap[pan], fontFamily: "'DM Mono', monospace", fontWeight: 600, fontSize: 12, background: `${panColorMap[pan]}12`, padding: "2px 8px", borderRadius: 4, border: `1px solid ${panColorMap[pan]}25` }}>{pan}</span>}
                        invested={pp.totalInvested} currentValue={pp.totalCurrentValue} absReturn={pp.totalAbsReturn} xirrVal={pp.portfolioXIRR} indent
                      />
                    );
                  })}
                </>
              )}
            </div>

            {/* Scheme table */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 16, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
              <TableHeader firstCol="Scheme" />
              {portfolio.schemeMetrics.map(s => (
                <SchemeRow key={s.isin} s={s}
                  panBreakdownMetrics={schemePerPAN[s.isin] || {}}
                  selectedPANs={selectedPANs}
                  panColorMap={panColorMap}
                  expanded={!!expandedSchemes[s.isin]}
                  onToggle={() => setExpandedSchemes(p => ({ ...p, [s.isin]: !p[s.isin] }))}
                />
              ))}
              {/* Totals */}
              <div style={{ display: "flex", padding: "12px 16px", background: C.accentLight, borderTop: `1.5px solid ${C.accentBorder}`, fontSize: 13, fontWeight: 700 }}>
                <div style={{ flex: COL.scheme, color: C.text }}>Portfolio Total</div>
                <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(portfolio.totalCurrentValue)} /></div>
                <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(portfolio.totalInvested)} color={C.textSecondary} /></div>
                <div style={{ flex: 1, textAlign: "right" }}><MonoVal value={fmt.inr(portfolio.totalCurrentValue - portfolio.totalInvested)} color={portfolio.totalCurrentValue >= portfolio.totalInvested ? C.green : C.red} /></div>
                <div style={{ flex: 1, textAlign: "right" }}><PctVal value={portfolio.totalAbsReturn} /></div>
                <div style={{ flex: 1, textAlign: "right" }}><PctVal value={portfolio.portfolioXIRR} /></div>
              </div>
            </div>

            {/* Capital Gains */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "18px 20px", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
              <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", fontWeight: 700, marginBottom: 12 }}>Capital Gains · FIFO per folio</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {portfolio.schemeMetrics.filter(s => s.gains.stcg !== 0 || s.gains.ltcg !== 0).map(s => (
                  <div key={s.isin} style={{ flex: 1, minWidth: 180, background: C.bg, borderRadius: 8, padding: "12px 14px", border: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 12, color: C.text, marginBottom: 8, fontWeight: 500 }}>{s.name.split("–")[0].trim()}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: C.textMuted }}>STCG</span>
                      <span style={{ color: s.gains.stcg > 0 ? C.amber : C.green, fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{fmt.inr(s.gains.stcg)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ color: C.textMuted }}>LTCG</span>
                      <span style={{ color: s.gains.ltcg > 0 ? C.amber : C.green, fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{fmt.inr(s.gains.ltcg)}</span>
                    </div>
                  </div>
                ))}
                {portfolio.schemeMetrics.every(s => s.gains.stcg === 0 && s.gains.ltcg === 0) && (
                  <div style={{ color: C.textMuted, fontSize: 13 }}>No redemptions — no capital gains to report.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
