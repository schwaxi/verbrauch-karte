// verbrauch-karte v1.0.0
// Einzeln installierbares Modul (Home Assistant Marketplace / HACS, Kategorie Dashboard).
window.customCards = window.customCards || [];
window.customCardFeatures = window.customCardFeatures || [];
// Eigener Block: Namen bleiben lokal, auch wenn mehrere Karten zusammen geladen werden.
{
// ---------------------------------------------------------------------------
// Verbrauch-Karte: Balken pro Stunde / Tag / Monat aus der Langzeitstatistik eines Zaehlers
// (z. B. Wasser, Strom), mit waehlbarem Zeitraum und Blaettern zurueck/vor.
//
//   type: custom:verbrauch-karte
//   entity: sensor.wasserverbrauch_hauptzahler   # Zaehler mit state_class total/total_increasing
//   titel: Verbrauch pro Tag
//   periode: day            # hour | day | month
//   farbe: "#29b6f6"        # optional
//   zeitraeume: [{ t: "7 Tage", n: 7 }, ...]   # optional, n = Anzahl Balken
//   standard: 14            # optional

const TYPE7 = "verbrauch-karte";
const WT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MON = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

class VerbrauchKarte extends HTMLElement {
  setConfig(c) {
    if (!c?.entity) throw new Error("entity fehlt");
    const periode = ["hour", "day", "month"].includes(c.periode) ? c.periode : "day";
    const std = {
      hour: [{ t: "24 Std", n: 24 }, { t: "48 Std", n: 48 }, { t: "7 Tage", n: 168 }],
      day: [{ t: "7 Tage", n: 7 }, { t: "14 Tage", n: 14 }, { t: "30 Tage", n: 30 }, { t: "90 Tage", n: 90 }],
      month: [{ t: "6 Monate", n: 6 }, { t: "12 Monate", n: 12 }, { t: "24 Monate", n: 24 }],
    };
    this._config = { titel: "", farbe: "#29b6f6", ...c, periode, zeitraeume: c.zeitraeume || std[periode] };
    this._key = `verbrauch-karte:${c.entity}:${periode}`;
    let n = NaN;
    try { n = Number(localStorage.getItem(this._key)); } catch (e) { /* kein Speicher */ }
    const z = this._config.zeitraeume;
    this._n = z.some((x) => x.n === n) ? n : (z.some((x) => x.n === c.standard) ? c.standard : (z[1] || z[0]).n);
    this._seite = 0;
    this._daten = null;
    this._render();
  }

  set hass(hass) {
    const erst = !this._hass;
    this._hass = hass;
    if (erst || Date.now() - (this._geladen || 0) > 5 * 60 * 1000) this._laden();
  }

  // Zeitfenster der aktuellen Seite (lokale Zeit)
  _fenster() {
    const p = this._config.periode, n = this._n, s = this._seite, jetzt = new Date();
    if (p === "hour") {
      const ende = new Date(jetzt); ende.setMinutes(0, 0, 0); ende.setHours(ende.getHours() + 1 - s * n);
      const start = new Date(ende); start.setHours(start.getHours() - n);
      return { start, ende };
    }
    if (p === "day") {
      const ende = new Date(jetzt); ende.setHours(0, 0, 0, 0); ende.setDate(ende.getDate() + 1 - s * n);
      const start = new Date(ende); start.setDate(start.getDate() - n);
      return { start, ende };
    }
    const ende = new Date(jetzt.getFullYear(), jetzt.getMonth() + 1 - s * n, 1);
    const start = new Date(ende.getFullYear(), ende.getMonth() - n, 1);
    return { start, ende };
  }

  _schluessel(d) {
    const p = this._config.periode;
    return p === "hour" ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`
      : p === "day" ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : `${d.getFullYear()}-${d.getMonth()}`;
  }

  _weiter(d) {
    const p = this._config.periode;
    if (p === "hour") d.setHours(d.getHours() + 1);
    else if (p === "day") d.setDate(d.getDate() + 1);
    else d.setMonth(d.getMonth() + 1);
  }

  async _laden() {
    if (!this._hass || !this._config) return;
    const nr = (this._ladeNr = (this._ladeNr || 0) + 1);
    const { start, ende } = this._fenster();
    this._geladen = Date.now();
    this._fehler = null;
    let zeilen = [];
    try {
      const r = await this._hass.callWS({
        type: "recorder/statistics_during_period", start_time: start.toISOString(), end_time: ende.toISOString(),
        statistic_ids: [this._config.entity], period: this._config.periode, types: ["change"],
      });
      zeilen = r[this._config.entity] || [];
    } catch (e) {
      if (nr === this._ladeNr) this._fehler = String(e?.message || e);
    }
    if (nr !== this._ladeNr) return;
    const werte = new Map();
    for (const z of zeilen) {
      const d = new Date(typeof z.start === "number" ? z.start : Date.parse(z.start));
      if (z.change != null) werte.set(this._schluessel(d), (werte.get(this._schluessel(d)) || 0) + z.change);
    }
    const balken = [];
    const t = new Date(start);
    for (let i = 0; i < 1000 && t < ende; i++) {
      const k = this._schluessel(t);
      balken.push({ d: new Date(t), v: werte.has(k) ? werte.get(k) : null });
      this._weiter(t);
    }
    this._daten = { balken, start, ende };
    this._auswahl = null;
    this._zeichnen();
  }

  _zahl(v) {
    const ein = this._hass?.states[this._config.entity]?.attributes?.unit_of_measurement || "";
    const st = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
    return `${v.toLocaleString("de-DE", { maximumFractionDigits: st })} ${ein}`.trim();
  }

  _beschriftung(d, lang) {
    const p = this._config.periode, dd = String(d.getDate()).padStart(2, "0"), mm = String(d.getMonth() + 1).padStart(2, "0");
    if (p === "hour") return lang ? `${WT[d.getDay()]} ${dd}.${mm}. ${d.getHours()}:00` : `${d.getHours()}`;
    if (p === "day") return lang ? `${WT[d.getDay()]} ${dd}.${mm}.${d.getFullYear()}` : (this._n > 14 ? `${dd}.` : `${WT[d.getDay()]} ${dd}.`);
    return lang ? `${MON[d.getMonth()]} ${d.getFullYear()}` : MON[d.getMonth()];
  }

  _bereichText() {
    const { start, ende } = this._daten || this._fenster();
    const p = this._config.periode, f = (d) => `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
    const letzt = new Date(ende);
    if (p === "hour") { letzt.setHours(letzt.getHours() - 1); return `${f(start)} ${start.getHours()}:00 – ${f(letzt)} ${letzt.getHours()}:59`; }
    if (p === "day") { letzt.setDate(letzt.getDate() - 1); return `${f(start)} – ${f(letzt)}${letzt.getFullYear()}`; }
    letzt.setMonth(letzt.getMonth() - 1);
    return `${MON[start.getMonth()]} ${start.getFullYear()} – ${MON[letzt.getMonth()]} ${letzt.getFullYear()}`;
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { padding: 12px 16px; box-sizing: border-box; }
        .kopf { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
        .titel { flex: 1; font-size: 15px; font-weight: 500; color: var(--primary-text-color); }
        .summe { font-size: 13px; color: var(--secondary-text-color); }
        .nav { display: flex; align-items: center; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
        .bereich { font-size: 13px; color: var(--primary-text-color); min-width: 130px; text-align: center; }
        .platz { flex: 1; }
        button { font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 16px; cursor: pointer;
          border: 1px solid var(--divider-color, #555); background: transparent; color: var(--primary-text-color); }
        button.pfeil { padding: 2px 10px; font-size: 16px; line-height: 1.2; }
        button:disabled { opacity: 0.35; cursor: default; }
        button.aktiv { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
        .chart { position: relative; height: 170px; display: flex; align-items: flex-end; gap: 2px;
          border-bottom: 1px solid var(--divider-color, #555); padding-top: 16px; }
        .max { position: absolute; top: 0; left: 0; font-size: 11px; color: var(--secondary-text-color); }
        .linie { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--divider-color, #555); opacity: 0.6; pointer-events: none; }
        .b { flex: 1; min-width: 1px; border-radius: 3px 3px 0 0; cursor: pointer; opacity: 0.85; }
        .b:hover, .b.sel { opacity: 1; outline: 2px solid var(--primary-text-color); outline-offset: -2px; }
        .b.leer { background: transparent !important; }
        .achse { display: flex; gap: 2px; margin-top: 3px; }
        .achse span { flex: 1; min-width: 1px; font-size: 10px; color: var(--secondary-text-color); text-align: center; white-space: nowrap; overflow: visible; }
        .info { min-height: 18px; font-size: 13px; margin-top: 6px; color: var(--primary-text-color); }
      </style>
      <ha-card>
        <div class="kopf"><span class="titel"></span><span class="summe"></span></div>
        <div class="nav">
          <button class="pfeil zur" title="zurück">‹</button>
          <span class="bereich"></span>
          <button class="pfeil vor" title="vor">›</button>
          <span class="platz"></span>
          <span class="zr"></span>
        </div>
        <div class="chart"><span class="max"></span></div>
        <div class="achse"></div>
        <div class="info"></div>
      </ha-card>`;
    const r = this.shadowRoot;
    r.querySelector(".titel").textContent = this._config.titel;
    r.querySelector(".zur").addEventListener("click", () => { this._seite++; this._laden(); this._zeichnen(); });
    r.querySelector(".vor").addEventListener("click", () => { if (this._seite > 0) { this._seite--; this._laden(); this._zeichnen(); } });
    const zr = r.querySelector(".zr");
    for (const z of this._config.zeitraeume) {
      const b = document.createElement("button");
      b.textContent = z.t; b.dataset.n = String(z.n);
      b.addEventListener("click", () => {
        if (z.n === this._n) return;
        this._n = z.n; this._seite = 0;
        try { localStorage.setItem(this._key, String(z.n)); } catch (e) { /* kein Speicher */ }
        this._laden(); this._zeichnen();
      });
      zr.appendChild(b);
    }
    this._zeichnen();
  }

  _zeichnen() {
    const r = this.shadowRoot;
    if (!r || !this._config) return;
    r.querySelectorAll(".zr button").forEach((b) => b.classList.toggle("aktiv", Number(b.dataset.n) === this._n));
    r.querySelector(".vor").disabled = this._seite === 0;
    r.querySelector(".bereich").textContent = this._bereichText();
    const chart = r.querySelector(".chart"), achse = r.querySelector(".achse"), info = r.querySelector(".info");
    chart.querySelectorAll(".b, .linie").forEach((x) => x.remove());
    achse.innerHTML = "";
    const d = this._daten;
    if (!d) { info.textContent = "Lade …"; return; }
    const gueltig = d.balken.filter((x) => x.v != null);
    const max = Math.max(0, ...gueltig.map((x) => x.v));
    const summe = gueltig.reduce((s, x) => s + x.v, 0);
    r.querySelector(".summe").textContent = gueltig.length
      ? `Summe ${this._zahl(summe)} · Ø ${this._zahl(summe / gueltig.length)}` : "";
    r.querySelector(".max").textContent = max > 0 ? `max ${this._zahl(max)}` : "";
    if (max > 0 && gueltig.length) {
      const l = document.createElement("div");
      l.className = "linie";
      l.style.bottom = `${((summe / gueltig.length) / max) * 154}px`;
      l.title = "Durchschnitt";
      chart.appendChild(l);
    }
    const jede = Math.max(1, Math.ceil(d.balken.length / 10));
    d.balken.forEach((x, i) => {
      const b = document.createElement("div");
      b.className = "b" + (x.v == null ? " leer" : "");
      b.style.background = this._config.farbe;
      b.style.height = x.v != null && max > 0 ? `${Math.max(1, (x.v / max) * 154)}px` : "0";
      const text = `${this._beschriftung(x.d, true)}: ${x.v != null ? this._zahl(x.v) : "keine Daten"}`;
      b.title = text;
      b.addEventListener("click", () => {
        chart.querySelectorAll(".b.sel").forEach((y) => y.classList.remove("sel"));
        b.classList.add("sel");
        info.textContent = text;
      });
      chart.appendChild(b);
      const s = document.createElement("span");
      s.textContent = i % jede === 0 ? this._beschriftung(x.d, false) : "";
      achse.appendChild(s);
    });
    info.textContent = this._fehler ? `Fehler: ${this._fehler}` : (gueltig.length ? "Balken antippen für den genauen Wert" : "Keine Daten in diesem Zeitraum");
  }

  getCardSize() { return 6; }
  getGridOptions() { return { columns: "full", rows: "auto" }; }
}

if (!customElements.get(TYPE7)) customElements.define(TYPE7, VerbrauchKarte);
if (!window.customCards.some((c) => c.type === TYPE7)) {
  window.customCards.push({ type: TYPE7, name: "Verbrauch-Karte", description: "Verbrauch pro Stunde/Tag/Monat mit Zeitraumwahl und Blättern" });
}

// Eingabemaske (visueller Editor) und Startwerte
{
  const ids = (hass) => Object.keys(hass?.states ?? {});
  const finde = (hass, re, dom = "sensor.") => ids(hass).find((id) => id.startsWith(dom) && re.test(id)) || "";
  const ent = (domain, extra = {}) => ({ entity: { filter: { domain, ...extra } } });
  const nummer = (min, max, step = 1, unit) => ({ number: { min, max, step, mode: "box", ...(unit ? { unit_of_measurement: unit } : {}) } });
  const auswahl = (opts) => ({ select: { mode: "dropdown", options: opts.map(([value, label]) => ({ value, label })) } });
  const text = { text: {} };
  const formular = (schema, labels, hilfen = {}) => () => ({
    schema,
    computeLabel: (s) => labels[s.name] ?? s.name,
    computeHelper: (s) => hilfen[s.name],
  });
  const setze = (typ, form, stub) => {
    const K = customElements.get(typ);
    if (!K) return;
    if (form) K.getConfigForm = form;
    if (stub) K.getStubConfig = (hass) => Object.fromEntries(Object.entries(stub(hass)).filter(([, v]) => v !== ""));
  };
  setze("verbrauch-karte",
    formular([
      { name: "entity", required: true, selector: ent("sensor") },
      { name: "titel", selector: text },
      { type: "grid", name: "", schema: [
        { name: "periode", selector: auswahl([["hour", "Pro Stunde"], ["day", "Pro Tag"], ["month", "Pro Monat"]]) },
        { name: "farbe", selector: text },
      ] },
      { name: "zeitraeume", selector: { object: {} } },
    ], { entity: "Zähler", titel: "Titel", periode: "Balken", farbe: "Farbe", zeitraeume: "Zeitraum-Tasten (optional)" },
    { entity: "Sensor mit Zählerstand (state_class total/total_increasing), z. B. Wasser oder Strom",
      farbe: "z. B. #29b6f6", zeitraeume: "Leer lassen für Standard. Format: - t: 7 Tage / n: 7" }),
    (hass) => ({ entity: finde(hass, /wasserverbrauch_hauptzahler|verbrauch|energy/), titel: "Verbrauch pro Tag", periode: "day" }));
}
}

console.info("%c verbrauch-karte %c v1.0.0 ", "color:#fff;background:#03a9f4;font-weight:700", "color:#03a9f4");
