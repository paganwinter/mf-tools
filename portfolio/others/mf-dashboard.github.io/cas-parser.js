const Y_BAND_PT = 3;
const COLUMN_GAP_PT = 3;

const ISIN_TOLERANT_RE = /ISIN(?:[^\n]{0,80}?)(IN(?:\s*[A-Z0-9]){9}\s*\d)(?![A-Z0-9])/i;
const SCHEME_CODE_RE = /^\s*[A-Z0-9](?:\s*[A-Z0-9]){0,9}\s*-\s*/;

const NUM_TOK = /^-?\(?-?[\d,]+(?:\.\d+)?\)?\*?$/;


function isinCheckDigitValid(isin) {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return false;
  let digits = '';
  for (const c of isin.slice(0, -1)) {
    digits += /[0-9]/.test(c) ? c : (c.charCodeAt(0) - 55).toString();
  }
  let sum = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    let d = parseInt(rev[i], 10);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === parseInt(isin.slice(-1), 10);
}

function parseCasNum(s) {
  if (s == null) return 0;
  let str = String(s).trim();
  let neg = false;
  if (/^\(.*\)$/.test(str)) { neg = true; str = str.slice(1, -1); }
  str = str.replace(/,/g, '').replace(/[^\d\.\-]/g, '');
  const n = parseFloat(str);
  if (isNaN(n)) return 0;
  return neg ? -n : n;
}
function parseCasDate(d) {
  // "01-Jan-2024" → ISO date
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(d.trim());
  if (!m) return null;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mi = months.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
function toTitleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

function tryExtractTxn(line) {
  const txt = line.text;
  const dateM = /^(\d{1,2}-[A-Za-z]{3}-\d{4})(?:\s+|\t\t)([\s\S]*)$/.exec(txt);
  if (!dateM) return null;
  const [, date, restRaw] = dateM;
  const rest = restRaw.trim();

  // Primary: split on \t\t (column boundary).
  const rawCols = rest.split(/\t\t/).map(c => c.replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  if (rawCols.length >= 1) {
    // Collect trailing numeric columns right-to-left.
    let numTail = [];
    let textEnd = rawCols.length;  // exclusive index of last "text" column
    for (let k = rawCols.length - 1; k >= 0; k--) {
      if (NUM_TOK.test(rawCols[k])) { numTail.unshift(parseCasNum(rawCols[k])); textEnd = k; }
      else break;
    }
    // pdf.js often keeps description + amount + units fused into one column when
    // the x-gap between them is smaller than the gap before NAV/balance. Peel
    // any trailing "\s NUM" tokens out of the last text column so they count as
    // additional numeric cols. Iterate — `(83,591.00) (1,609.888)` peels in two
    // passes (one for the trailing number, one for the remaining NUM_TOK string).
    // Pattern: allow parenthesised negatives and optional `*` marker.
    const PEEL_TAIL_RE = /^([\s\S]*?)((?:\s(?:-?\(?[\d,]+(?:\.\d+)?\)?\*?)){1,4})\s*$/;
    for (let safety = 0; safety < 6 && textEnd > 0; safety++) {
      const lastText = rawCols[textEnd - 1];
      if (!lastText) { rawCols.splice(textEnd - 1, 1); textEnd--; continue; }
      if (NUM_TOK.test(lastText)) {
        numTail.unshift(parseCasNum(lastText));
        rawCols.splice(textEnd - 1, 1);
        textEnd--;
        continue;
      }
      const mm = PEEL_TAIL_RE.exec(lastText);
      if (!mm || !mm[2].trim()) break;
      const extras = mm[2].trim().split(/\s+/).map(parseCasNum);
      const pre = mm[1].trim();
      numTail = [...extras, ...numTail];
      if (!pre) { rawCols.splice(textEnd - 1, 1); textEnd--; }
      else rawCols[textEnd - 1] = pre;
    }

    const numCount = numTail.length;
    const desc = rawCols.slice(0, textEnd).join(' ').trim();
    if (numCount >= 1 && desc) {
      if (numCount >= 4) {
        const [amount, units, nav, balance] = numTail.slice(-4);
        return { date, desc, amount, units, nav, balance, shape: 4 };
      }
      if (numCount === 3) {
        // 3 trailing numerics is classic dividend-payout (units unchanged).
        if (DIVIDEND_RE.test(desc)) {
          const [amount, nav, balance] = numTail;
          return { date, desc, amount, units: 0, nav, balance, shape: 3 };
        }
        // Otherwise assume [amount, units, balance] (rare; nav missing).
        const [amount, units, balance] = numTail;
        return { date, desc, amount, units, nav: 0, balance, shape: 3 };
      }
      if (numCount === 2) {
        // Segregated portfolio / side-pocket only; otherwise too ambiguous to claim.
        if (/segregated|side\s*pocket/i.test(desc)) {
          return { date, desc, amount: numTail[0], units: 0, nav: 0, balance: numTail[1], shape: 2 };
        }
        // Fall through — don't claim a transaction we can't explain.
      }
      if (numCount === 1) {
        // Tax rows: STT, stamp duty, TDS. These are charges, not trades.
        if (/\bstt\b|stamp\s*duty|\btds\b|tax\s*deducted/i.test(desc)) {
          return { date, desc, amount: numTail[0], units: 0, nav: 0, balance: 0, shape: 1 };
        }
      }
    }
  }

  // Fallback: regex-only, when columns didn't come through.
  const T4 = /(-?\(?[\d,]+(?:\.\d+)?\)?)\s+(-?\(?[\d,]+(?:\.\d+)?\)?)\s+(-?\(?[\d,]+(?:\.\d+)?\)?)\s+(-?\(?[\d,]+(?:\.\d+)?\)?)\s*\*?\s*$/;
  const m4 = T4.exec(rest);
  if (m4) {
    const desc = rest.slice(0, m4.index).trim();
    if (desc) return {
      date, desc,
      amount: parseCasNum(m4[1]),
      units: parseCasNum(m4[2]),
      nav: parseCasNum(m4[3]),
      balance: parseCasNum(m4[4]),
      shape: 4,
    };
  }

  const T3 = /(-?\(?[\d,]+(?:\.\d+)?\)?)\s+(-?\(?[\d,]+(?:\.\d+)?\)?)\s+(-?\(?[\d,]+(?:\.\d+)?\)?)\s*\*?\s*$/;
  const m3 = T3.exec(rest);
  if (m3) {
    const desc = rest.slice(0, m3.index).trim();
    // Only accept 3-col fallback for dividend-shaped descriptions to avoid swallowing
    // summary lines ("Total Cost Value: X Market Value on Y: Z") as transactions.
    if (desc && DIVIDEND_RE.test(desc)) return {
      date, desc,
      amount: parseCasNum(m3[1]),
      units: 0,
      nav: parseCasNum(m3[2]),
      balance: parseCasNum(m3[3]),
      shape: 3,
    };
  }

  // 2-col and 1-col fallbacks only accepted when the description hints at the shape
  // (segregated portfolio / tax row). Without this guard, almost any text line with
  // trailing numbers would match.
  const T2 = /(-?\(?[\d,]+(?:\.\d+)?\)?)\s+(-?\(?[\d,]+(?:\.\d+)?\)?)\s*\*?\s*$/;
  const m2 = T2.exec(rest);
  if (m2) {
    const desc = rest.slice(0, m2.index).trim();
    if (desc && /segregated|side\s*pocket/i.test(desc)) return {
      date, desc,
      amount: parseCasNum(m2[1]),
      units: 0, nav: 0,
      balance: parseCasNum(m2[2]),
      shape: 2,
    };
  }

  const T1 = /(-?\(?[\d,]+(?:\.\d+)?\)?)\s*\*?\s*$/;
  const m1 = T1.exec(rest);
  if (m1) {
    const desc = rest.slice(0, m1.index).trim();
    if (desc && /\bstt\b|stamp\s*duty|\btds\b|tax\s*deducted/i.test(desc)) return {
      date, desc,
      amount: parseCasNum(m1[1]),
      units: 0, nav: 0, balance: 0,
      shape: 1,
    };
  }

  return null;
}

function classifyTxn(desc) {
  const d = (desc || '').toLowerCase();
  // Reversals first — a rejected SIP / dishonoured cheque must not be
  // treated as a purchase even though the description contains "purchase".
  if (/reversal|rejection|dishonou?red|mismatch|insufficient\s*balance/.test(d)) return 'REVERSAL';
  // Primary action verbs next. These MUST win over TAX/STAMP because CAMS
  // descriptions like "Redemption less TDS, STT" or "Purchase - less stamp duty"
  // embed tax keywords as suffixes. Classifying such a row as TAX would drop
  // the main transaction's amount from the invested-sum reconciliation.
  if (/switch\s*out|switch-out|merger.*out/.test(d)) return 'SWITCH_OUT';
  if (/switch\s*in|switch-in|merger.*in/.test(d)) return 'SWITCH_IN';
  if (/systematic\s*withdrawal|\bswp\b/.test(d)) return 'REDEMPTION';
  if (/systematic\s*transfer|\bstp\s*out/.test(d)) return 'SWITCH_OUT';
  if (/\bstp\s*in/.test(d)) return 'SWITCH_IN';
  if (/systematic\s*(investment|purchase)/.test(d)) return 'SIP';
  if (/instal+ment/.test(d)) return 'SIP';
  if (/sys\.?\s*invest/.test(d)) return 'SIP';
  if (/\bsip\b/.test(d)) return 'SIP';
  if (/redemption|redeem/.test(d)) return 'REDEMPTION';
  if (/(div\.?|dividend|idcw).*reinvest/.test(d)) return 'DIVIDEND_REINVEST';
  if (/(div\.?|dividend|idcw)/.test(d)) return 'DIVIDEND_PAYOUT';
  if (/segregated|side\s*pocket/.test(d)) return 'SEGREGATED';
  if (/\bpurchase\b|allot/.test(d)) return 'PURCHASE';
  // Tax/stamp classification only when no action verb matched — these are
  // standalone charge rows like "*** Stamp Duty ***" or "*** STT Paid ***".
  if (/stamp\s*duty/.test(d)) return 'STAMP_DUTY';
  if (/\bstt\b|securities\s*transaction\s*tax/.test(d)) return 'TAX';
  if (/\btds\b|tax\s*deducted/.test(d)) return 'TAX';
  return 'OTHER';
}
function cleanSchemeName(raw) {
  return (raw || '')
    // pdf.js can fragment tokens: "( Non - Demat )" → tighten inner spaces
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\(([^)]+)\)/g, (m, inner) => '(' + inner.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim() + ')')
    .replace(/\s*\(Non-Demat\)\s*/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[-\s]+|[-\s]+$/g, '');
}

async function extractLines(pdf, opts = {}) {
  const yBand = opts.yBand ?? Y_BAND_PT;
  const columnGap = opts.columnGap ?? COLUMN_GAP_PT;
  const rawLines = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const items = content.items.filter(it => it.str && it.transform);
    if (!items.length) continue;
    // Bucket into y-bands.
    const bands = [];
    for (const it of items) {
      const y = it.transform[5];
      let band = null;
      for (const b of bands) {
        if (Math.abs(b.y - y) <= yBand) { band = b; break; }
      }
      if (!band) { band = { y, items: [] }; bands.push(band); }
      band.items.push(it);
    }
    // Sort bands top-down (descending y).
    bands.sort((a, b) => b.y - a.y);
    for (const band of bands) {
      band.items.sort((a, b) => a.transform[4] - b.transform[4]);
      let out = '';
      let prevRight = null;
      for (const it of band.items) {
        const x = it.transform[4];
        const w = it.width || 0;
        if (prevRight == null) {
          out = it.str;
        } else {
          const gap = x - prevRight;
          if (gap >= columnGap) out += '\t\t' + it.str;
          else if (gap > 0) out += ' ' + it.str;
          else out += it.str;
        }
        prevRight = x + w;
      }
      // Normalize: collapse tab clusters (possibly wrapped by spaces) → \t\t;
      // collapse multi-spaces → single space. Preserve \t\t as column boundary.
      const text = out
        .replace(/[ \t]*\t+[ \t]*/g, '\t\t')
        .replace(/ {2,}/g, ' ')
        .trim();
      if (text) rawLines.push({ page: i, y: band.y, text });
    }
  }
  return rawLines;
}
// Format detection — scans line text for depository / registrar marker strings.
// Returns one of 'CAMS' | 'CDSL' | 'NSDL' | 'KFINTECH' | 'UNKNOWN'. Markers
// are taken from codereverser/casparser's `parse_file_type` in parsers/mupdf.py.
//
// Order matters: CAMS is checked FIRST because CAMS CAS PDFs may incidentally
// mention "Central Depository Services" or "NSDL" in footer disclaimers. The
// `CAMSCASWS` / `camsonline.com` markers are unambiguous — if they're present,
// the file is definitely a CAMS CAS. Same logic for KFintech after CAMS.
function detectFormat(lines) {
  const fullText = lines.map(l => l.text).join(' | ');
  if (/CAMSCAS(?:WS)?|camsonline\.com/i.test(fullText)) return 'CAMS';
  if (/KFINCAS|KFINTECH\s+Consolidated|WWW\.KFINTECH\.COM|mfs\.kfintech\.com/i.test(fullText)) return 'KFINTECH';
  if (/Central\s+Depository\s+Services\s*\(India\)\s*Limited/i.test(fullText)) return 'CDSL';
  if (/NSDL\s+Consolidated\s+Account\s+Statement|About\s+NSDL/i.test(fullText)) return 'NSDL';
  return 'UNKNOWN';
}
// Pure function — takes pre-extracted lines and runs the full CAMS classifier.
// Exposed so the fixture harness can feed hand-written line arrays without a PDF.
function parseCAMSFromLines(lines, pageCount) {
  pageCount = pageCount || 1;
  const fullText = lines.map(l => l.text).join(' | ');

  // Sanity-check: reject files that don't look like CAMS CAS before doing
  // CAMS-specific parsing. This is a defensive backstop — the main router in
  // parseCAS() already handled format dispatch, but tests may call this
  // function directly with fixture lines.
  if (!/CAMSCAS(?:WS)?|camsonline\.com/i.test(fullText)) {
    throw Object.assign(new Error('Not a CAMS CAS.'), { code: 'UNSUPPORTED_FORMAT' });
  }

  // Summary vs Detailed CAS — only Detailed contains the transaction history
  // we need. A Summary CAS has folios + scheme names but no per-txn rows,
  // which silently produced "0 funds" before. Reject explicitly.
  const casTypeM = /(Detailed|Summary)\s+Consolidated\s+Account\s+Statement/i.exec(fullText);
  const explicitDetailed = casTypeM && /detailed/i.test(casTypeM[1]);
  const explicitSummary = casTypeM && /summary/i.test(casTypeM[1]);
  if (explicitSummary) {
    throw Object.assign(
      new Error('This appears to be a Summary CAS. Mitra needs a Detailed CAS — re-download from camsonline.com and choose "Detailed" (not "Summary").'),
      { code: 'UNSUPPORTED_CAS_SUMMARY' }
    );
  }

  const markersSeen = new Set();
  markersSeen.add(/CAMSCASWS/i.test(fullText) ? 'CAMSCASWS' : 'CAMSCAS');
  if (/camsonline\.com/i.test(fullText)) markersSeen.add('camsonline.com');
  if (explicitDetailed) markersSeen.add('Detailed CAS');
  if (/Segregated\s*Portfolio/i.test(fullText)) markersSeen.add('Segregated Portfolio');

  let investorName = '';
  let pan = '';
  const funds = [];
  const folios = []; // mine
  const pans = {}; // mine
  let currentFund = null;
  let currentAmc = '';
  let currentFolio = '';
  const warnings = [];
  let rowsClassified = 0;
  let rowsUnknown = 0;

  const panRe = /\b([A-Z]{5}\d{4}[A-Z])\b/;
  const amcRe = /^([A-Z][A-Za-z0-9 &().'-]+?)\s+(Mutual\s+Fund|MF)\s*$/;
  const folioRe = /Folio\s*No\.?\s*:?\s*([\w\s\/\-]+?)(?=\s+PAN|\s+KYC|$)/i;
  const isinRe = /ISIN\s*:?\s*([A-Z]{2}[A-Z0-9]{9}\d)\b/;
  // Scheme line: no ^ anchor — pdf.js can prepend runs of whitespace or merged text.
  const schemeRe = /([A-Z0-9]{1,10})-(.+?)\s*-\s*ISIN\s*:\s*[A-Z]{2}[A-Z0-9]{9}\d/;
  const openingRe = /Opening\s+Unit\s+Balance\s*:?\s*([\-\(\)\d,\.]+)/i;
  const closingRe = /Closing\s+Unit\s+Balance\s*:?\s*([\-\(\)\d,\.]+)/i;
  const costRe = /Total\s+Cost\s+Value\s*:\s*([\-\(\)\d,\.]+)/i;
  // Older CAMS statements use "Valuation on" in place of "Market Value on".
  const marketRe = /(?:Market\s+Value|Valuation)\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\-\(\)\d,\.]+)/i;
  const navRe = /NAV\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\-\(\)\d,\.]+)/i;
  // Investor-name regex accepts optional titles (MR/MRS/SMT/MS/SHRI/DR/M/S)
  // and trailing suffixes ((MINOR)/(HUF)/(KARTA)/(POA)). Broader than v1 which
  // silently skipped joint/minor holders.
  const nameCandidateRe = /^(?:(?:MR|MRS|SMT|MS|SHRI|DR|M\/S)\.?\s+)?[A-Z][A-Za-z]+(?:\s+(?:[A-Z]\.?|[A-Z][A-Za-z]+)){0,4}(?:\s*\((?:MINOR|HUF|KARTA|POA)\))?$/;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;

    // PAN
    // if (!pan) {
    //   const m = panRe.exec(text);
    //   if (m) pan = m[1];
    // }
    const m = panRe.exec(text);
    if (m) {
      pan = m[1];
      if (!pans[pan]) pans[pan] = {
        number: pan,
        name: toTitleCase(lines[i + 1].text.trim()),
      }
    }

    // AMC section heading
    const amcLine = amcRe.exec(text);
    if (amcLine) { currentAmc = amcLine[1].trim(); continue; }

    // Folio — starts a new fund block
    const folio = folioRe.exec(text);
    if (folio) {
      currentFolio = folio[1].replace(/\s+/g, '').trim();
      currentFund = {
        pan, // mine
        folioNumber: currentFolio, // mine
        amc: currentAmc,
        schemeName: '',
        isin: '',
        category: '',
        transactions: [],
        openingBalance: 0,
        closingBalance: null,
        costValue: null,
        marketValue: null,
        casNav: null,
        casNavDate: null,
      };
      funds.push(currentFund);
      folios.push(currentFund); // mine

      // Investor name: scan the next few lines for a simple capitalized name
      if (!investorName) {
        for (let j = 1; j <= 3 && i + j < lines.length; j++) {
          const cand = lines[i + j].text.trim();
          if (nameCandidateRe.test(cand)) { investorName = toTitleCase(cand); break; }
        }
      }
      continue;
    }

    // ISIN + scheme name — the CAMS scheme line looks like:
    //   `<CODE>-<SCHEME NAME> - ISIN: <ISIN>(Advisor: ...) Registrar : ...`
    // pdf.js sometimes splits this across lines, or inserts spaces between glyphs.
    // Strategy: find the ISIN pattern on this line (tolerant of spaces), then extract
    // the scheme name from the text preceding it — optionally joining up to 2 prior lines
    // to cover the Registrar-line-wrap case where a long scheme name spans 3 y-bands.
    if (currentFund) {
      const candidates = [text.replace(/\t\t/g, ' ')];
      if (i > 0) candidates.push((lines[i - 1].text + ' ' + text).replace(/\t\t/g, ' '));
      if (i > 1) candidates.push((lines[i - 2].text + ' ' + lines[i - 1].text + ' ' + text).replace(/\t\t/g, ' '));
      // Try each candidate — earlier candidates may capture the ISIN, later
      // (longer) candidates may also capture the scheme name. Don't break early;
      // a single-line ISIN match without enough context to recover the scheme
      // name should not stop us from trying multi-line joins.
      for (let cIdx = 0; cIdx < candidates.length; cIdx++) {
        const cand = candidates[cIdx];
        const isinTok = ISIN_TOLERANT_RE.exec(cand);
        if (!isinTok) continue;
        const isin = isinTok[1].replace(/\s+/g, '');
        if (!isinCheckDigitValid(isin)) continue;
        if (!currentFund.isin) currentFund.isin = isin;
        if (!currentFund.schemeName) {
          let before = cand.slice(0, isinTok.index).replace(/\s*-\s*$/, '').trim();
          const codeMatch = SCHEME_CODE_RE.exec(before);
          let afterCode = codeMatch ? before.slice(codeMatch[0].length) : before;
          if (!codeMatch) {
            const inline = /(?:^|\s)([A-Z0-9](?:\s*[A-Z0-9]){0,9})\s*-\s*(.+)$/.exec(before);
            if (inline) afterCode = inline[2];
          }
          const cleaned = cleanSchemeName(afterCode);
          if (cleaned.length > 6) {
            currentFund.schemeName = cleaned;
            if (cIdx > 0) markersSeen.add('Registrar line-wrap');
          }
        }
        // Stop only once we have both isin and a usable scheme name.
        if (currentFund.isin && currentFund.schemeName) break;
      }
    }

    // Opening Unit Balance
    if (currentFund) {
      const om = openingRe.exec(text);
      if (om) currentFund.openingBalance = parseCasNum(om[1]);
    }

    // Transaction row
    if (currentFund) {
      const t = tryExtractTxn(lines[i]);
      if (t) {
        const type = classifyTxn(t.desc);
        currentFund.transactions.push({
          date: parseCasDate(t.date),
          description: t.desc,
          type,
          amount: t.amount,
          units: t.units,
          nav: t.nav,
          balance: t.balance,
          shape: t.shape,
        });
        if (type === 'OTHER') rowsUnknown++;
        else rowsClassified++;
        continue;
      }
      // Starts with a date but no shape matched — count as unknown so we can
      // surface coverage gaps in parseMetadata.
      if (/^\d{1,2}-[A-Za-z]{3}-\d{4}\b/.test(text.trim())) rowsUnknown++;
    }

    // Closing Unit Balance / cost / market / NAV — often on the same "footer" line
    if (currentFund) {
      const cm = closingRe.exec(text);
      if (cm) currentFund.closingBalance = parseCasNum(cm[1]);
      const tcv = costRe.exec(text);
      if (tcv) currentFund.costValue = parseCasNum(tcv[1]);
      const mkt = marketRe.exec(text);
      if (mkt) {
        currentFund.marketValue = parseCasNum(mkt[2]);
        currentFund.casNavDate = parseCasDate(mkt[1]);
        markersSeen.add(/Valuation/i.test(text) ? 'Valuation on' : 'Market Value on');
      }
      const navL = navRe.exec(text);
      if (navL) { currentFund.casNav = parseCasNum(navL[2]); currentFund.casNavDate = parseCasDate(navL[1]); }
    }
  }

  // Consolidate per fund: compute totalUnits + totalInvested.
  //
  // Summary-first model:
  //   Portfolio-summary anchors (costValue, closingBalance, casNav) are the
  //   source of truth for the dashboard. Transaction history is best-effort.
  //   When transaction sums disagree with the summary, we keep the summary
  //   and emit a soft warning — we never hard-fail on parse-history gaps.
  //
  // A fund is skipped only if it has *neither* a usable summary anchor *nor*
  // transactions. A fund with cost/closing anchors but zero parsed transactions
  // is still shown; we just note the missing history as a warning.
  const finalFunds = [];
  for (const f of funds) {
    const hasAnchor = (f.costValue != null && f.costValue > 0) || (f.closingBalance != null && f.closingBalance >= 0);
    if (!f.transactions.length && !hasAnchor) {
      warnings.push(`Folio ${f.folioNumber}: no transactions or summary totals parsed`);
      continue;
    }
    if (!f.schemeName) { warnings.push(`Folio ${f.folioNumber}: scheme name could not be identified`); continue; }

    // Transaction-derived totals (best-effort). STAMP_DUTY counts toward
    // cost because CAMS's "Total Cost Value" includes it. TAX (STT, TDS) is
    // typically deducted from redemption proceeds rather than added to cost,
    // so we leave it out.
    let txnInvested = 0;
    for (const t of f.transactions) {
      if (['PURCHASE','SIP','SWITCH_IN','DIVIDEND_REINVEST','STAMP_DUTY'].includes(t.type)) txnInvested += t.amount;
      else if (['REDEMPTION','SWITCH_OUT'].includes(t.type)) txnInvested -= Math.abs(t.amount);
    }
    let txnUnits = f.openingBalance || 0;
    for (const t of f.transactions) {
      if (['PURCHASE','SIP','SWITCH_IN','DIVIDEND_REINVEST'].includes(t.type)) txnUnits += t.units;
      else if (['REDEMPTION','SWITCH_OUT'].includes(t.type)) txnUnits -= Math.abs(t.units);
    }

    // totalInvested: summary anchor wins; fall back to transaction sum.
    let invested, investedSource;
    if (f.costValue != null && f.costValue > 0) {
      invested = f.costValue;
      investedSource = 'summary';
      // Soft warning when history materially disagrees with the summary.
      // Suppress when the fund had a non-zero opening balance — the gap is
      // expected in that case (pre-period purchases are outside the statement
      // window), summary anchors remain authoritative, and the warning would
      // just be noise.
      const hasPrePeriodUnits = (f.openingBalance || 0) > 0;
      if (f.transactions.length && !hasPrePeriodUnits && Math.abs(txnInvested - f.costValue) > 1) {
        warnings.push(
          `${f.schemeName}: transaction history incomplete (sum ${Math.round(txnInvested).toLocaleString('en-IN')} vs summary ${Math.round(f.costValue).toLocaleString('en-IN')}) — summary totals used`
        );
      }
    } else {
      invested = txnInvested;
      investedSource = 'transactions';
      warnings.push(`${f.schemeName || f.folioNumber}: summary "Total Cost Value" not found — computed from transactions`);
    }

    // totalUnits: closing-balance anchor wins; fall back to last running balance; last resort, recompute.
    let units, unitsSource;
    if (f.closingBalance != null && f.closingBalance >= 0) {
      units = f.closingBalance;
      unitsSource = 'summary';
    } else {
      const last = f.transactions[f.transactions.length - 1];
      if (last && !isNaN(last.balance) && last.balance >= 0) {
        units = last.balance;
        unitsSource = 'last-txn-balance';
      } else {
        units = txnUnits;
        unitsSource = 'transactions';
      }
      warnings.push(`${f.schemeName || f.folioNumber}: summary "Closing Unit Balance" not found — computed from transactions`);
    }

    finalFunds.push({
      ...f,
      totalUnits: units,
      totalInvested: invested,
      investedSource,
      unitsSource,
    });
  }

  // Consolidate across multiple folios under same ISIN (PRD 11: multi-folio auto-merge)
  const byKey = new Map();
  for (const f of finalFunds) {
    const key = f.isin || f.schemeName.toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, { ...f, folios: [f.folioNumber], transactions: [...f.transactions] });
    } else {
      const agg = byKey.get(key);
      agg.folios.push(f.folioNumber);
      agg.totalUnits += f.totalUnits;
      agg.totalInvested += f.totalInvested;
      if (f.marketValue != null) agg.marketValue = (agg.marketValue || 0) + f.marketValue;
      if (f.casNav && !agg.casNav) { agg.casNav = f.casNav; agg.casNavDate = f.casNavDate; }
      agg.transactions.push(...f.transactions);
    }
  }

  // Sort each fund's transactions by date
  const merged = [...byKey.values()].map(f => {
    f.transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return f;
  });

  // Debug aid: if nothing landed, dump the lines we saw.
  if (!merged.length) {
    console.warn('[Mitra] parser produced no funds. Sample of extracted lines:');
    for (let i = 0; i < Math.min(lines.length, 80); i++) {
      console.log(`L${i.toString().padStart(3,'0')}:`, JSON.stringify(lines[i].text));
    }
  }

  const parseMetadata = {
    version: explicitDetailed ? 'CAMS-DETAILED' : 'CAMS-DETAILED-INFERRED',
    markersSeen: [...markersSeen].sort(),
    rowsClassified,
    rowsUnknown,
    lineCount: lines.length,
    pageCount,
    fundCount: merged.length,
    parsedAt: new Date().toISOString(),
  };

  return {
    // investorName,
    // pan,
    funds: merged,
    warnings,
    parseMetadata,
    rawLines: lines,  // for diagnostic export (sanitized before persistence)
    pans, // mine
    folios, // mine
  };
}


pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
async function parseCAS(file, password) {
  const ab = await file.arrayBuffer();
  let pdf;
  const task = pdfjsLib.getDocument({ data: ab, password });
  pdf = await task.promise;

  const lines = await extractLines(pdf);
  const parsed = parseCAMSFromLines(lines, pdf.numPages);
  console.log({parsed})

  const folios = []

  parsed.folios.forEach(fol => {
    const scheme = {
      scheme: fol.schemeName,
      isin: fol.isin,
      amfi: null,
      advisor: 'schemeInfo.advisor',
      rta_code: 'schemeInfo.rtaCode',
      rta: 'schemeInfo.rta',
      nominees: [],
      open: fol.openingBalance,
      close: fol.closingBalance,
      close_calculated: fol.closingBalance,
      valuation: { date: fol.casNavDate, nav: fol.casNav, value: fol.marketValue, cost: fol.costValue },
      transactions: fol.transactions.map(txn => ({
        date: txn.date,
        description: txn.description,
        amount: txn.amount,
        units: txn.units,
        nav: txn.nav,
        balance: txn.balance,
        type: ['SIP', 'PURCHASE'].includes(txn.type)
          ? 'PURCHASE'
          : ['REDEMPTION'].includes(txn.type)
            ? 'REDEMPTION'
            : 'OTHER',
      })),
    };

    const existingFolio = folios.find(f => f.folioNumber === fol.folioNumber)
    if (!existingFolio) {
      const folio = {
        folio: fol.folioNumber,
        amc: fol.amc,
        PAN: fol.pan,
        KYC: 'OK',
        PANKYC: 'OK',
        schemes: [scheme],
      }
      folios.push(folio)
    } else {
      existingFolio.schemes.push(scheme)
    }
  })

  const parsedCAS = {
    statement_period: { from: null, to: null },
    file_type: "CAMS",
    cas_type: "DETAILED",
    investor_info: {
      email: 'e@m.co',
      name: 'John Doe',
      mobile: '1234567890',
      address: 'home',
    },
    folios,
  }

  return parsedCAS
}
