/*
 * Sellsy-Odys MCP — serveur Express pour Railway.
 * Logique Sellsy reprise du connecteur d'Odys (outils/connecteur-sellsy.js) : mêmes outils, même format
 * de réponse (structuredContent avec id, number, ht, ttc, pdf…) que celui attendu par Odys.
 *
 * Variables Railway : SELLSY_ID, SELLSY_SECRET, ODYS_KEY (longue et aléatoire), PORT (fourni par Railway).
 * Adresse du connecteur : https://<domaine>/mcp/<ODYS_KEY>
 */
import express from 'express';
import nodemailer from 'nodemailer';

/*
 * Connecteur Sellsy d'Odys (ENERGETIK FRANCE) — Cloudflare Worker, serveur MCP (HTTP « streamable », réponses JSON).
 * Crée immédiatement un devis dans Sellsy à partir d'une demande d'Odys.
 *
 * Variables secrètes du Worker (Settings → Variables and Secrets, type « Secret ») :
 *   SELLSY_ID      identifiant client de l'accès API Sellsy
 *   SELLSY_SECRET  secret de l'accès API Sellsy
 *   ODYS_KEY       clé d'accès longue et aléatoire : l'adresse du connecteur est https://<worker>/mcp/<ODYS_KEY>
 */
const API = 'https://api.sellsy.com/v2';
const VERSION = '2.11.0';
const PROTO = '2025-06-18';

const TOOLS = [{
  name: 'create_estimate',
  title: 'Créer un devis Sellsy',
  description: "Crée un devis dans Sellsy pour un dossier Odys : retrouve ou crée la fiche client, ajoute les lignes (articles du catalogue Sellsy ou lignes libres, titres de lots) et renvoie le numéro, les montants et les liens PDF du devis.",
  inputSchema: {
    type: 'object',
    properties: {
      job: {
        type: 'object',
        description: "Demande de devis Odys : client {sellsyId, sellsyType, forceNew, societe, civilite, nom, prenom, email, tel, adresse, cp, ville}, rows [{sellsyId, ref, nom, qte, pu, tva, fiche_technique} ou {type:'title', text}], date, subject, note, tvaDefaut, send_email (envoie le devis et les fiches techniques au client par e-mail).",
      },
    },
    required: ['job'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, {
  name: 'send_estimate',
  title: 'Envoyer un devis Sellsy par e-mail',
  description: "Envoie au client un e-mail avec le lien du devis Sellsy et les liens des fiches techniques des articles.",
  inputSchema: {
    type: 'object',
    properties: {
      estimate_id: { type: 'number', description: 'ID Sellsy du devis' },
      client_email: { type: 'string' },
      client_name: { type: 'string' },
      items: { type: 'array', description: 'Lignes [{nom, qte, pu, fiche_technique}]', items: { type: 'object' } },
      attachments: { type: 'array', description: 'Pièces jointes [{name, content (base64)}] : PDF ou images, 10 Mo au total', items: { type: 'object' } },
      attachment_ids: { type: 'array', description: 'Identifiants de pièces jointes déposées par stage_attachment', items: { type: 'string' } },
      mark_sent: { type: 'boolean', description: "Passer le devis brouillon au statut « Envoyé » après l'envoi (défaut : oui ; non pour un envoi de test)" },
      attach_pdf: { type: 'boolean', description: 'Joindre le PDF du devis (défaut : oui)' },
      stage_chunk: { type: 'object', description: "Dépôt d'un morceau de pièce jointe {upload_id, name, index, total, chunk} : n'envoie rien" },
      to_emails: { type: 'array', description: 'Autres destinataires (en plus de client_email)', items: { type: 'string' } },
      bcc_emails: { type: 'array', description: 'Destinataires en copie cachée', items: { type: 'string' } },
      subject: { type: 'string', description: "Objet de l'e-mail (sinon objet par défaut)" },
      message: { type: 'string', description: "Texte de l'e-mail rédigé (texte brut, paragraphes séparés par une ligne vide). Le bouton vers le devis est ajouté sous le texte." },
      include_items: { type: 'boolean', description: 'Ajouter le tableau des articles (défaut : oui si pas de message rédigé)' },
    },
    required: ['estimate_id', 'client_email'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, {
  name: 'stage_attachment',
  title: "Déposer une pièce jointe (par morceaux) avant l'envoi d'un devis",
  description: "Dépose un morceau (base64, 300 Ko max) d'une pièce jointe. Envoyer les morceaux dans l'ordre (index 0..total-1) avec le même upload_id, puis passer upload_id dans attachment_ids de send_estimate. Conservé 1 heure.",
  inputSchema: {
    type: 'object',
    properties: {
      upload_id: { type: 'string' }, name: { type: 'string' },
      index: { type: 'number' }, total: { type: 'number' }, chunk: { type: 'string' },
    },
    required: ['upload_id', 'name', 'index', 'total', 'chunk'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, {
  name: 'send_relance',
  title: 'Relancer le client sur son devis',
  description: "Envoie au client l'e-mail de relance du devis (7 jours après l'envoi). Ne fait rien si le devis est déjà accepté, refusé, annulé ou facturé dans Sellsy.",
  inputSchema: {
    type: 'object',
    properties: {
      estimate_id: { type: 'number', description: 'ID Sellsy du devis' },
      client_email: { type: 'string' },
      client_name: { type: 'string', description: 'Civilité et nom, ex. « M. Dupont »' },
      bcc_emails: { type: 'array', description: 'Destinataires en copie cachée', items: { type: 'string' } },
    },
    required: ['estimate_id', 'client_email'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, {
  name: 'catalog_api',
  title: 'Gérer le catalogue Sellsy',
  description: "Lit ou modifie le catalogue Sellsy (articles, taxes, unités) : appel direct de l'API Sellsy V2 : catalogue (/items, /taxes, /units) en lecture et écriture, clients et devis en lecture seule, sans suppression.",
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'] },
      path: { type: 'string', description: 'Chemin API V2, ex. /items?limit=100 ou /items/123' },
      body: { type: 'object' },
    },
    required: ['method', 'path'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, {
  name: 'ping',
  title: 'Tester la connexion Sellsy',
  description: "Vérifie que le connecteur joint Sellsy avec ses identifiants. Ne modifie rien.",
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: true },
}];

/* ---------- utilitaires ---------- */
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function phone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 10) d = '33' + d.slice(1);
  return d ? '+' + d : null;
}
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

class Sellsy {
  constructor(env) { this.env = env; this.token = null; this.taxes = null; }
  async auth() {
    if (this.token) return;
    const r = await fetch('https://login.sellsy.com/oauth2/access-tokens', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.env.SELLSY_ID || '', client_secret: this.env.SELLSY_SECRET || '' }),
    });
    if (!r.ok) throw new Error('Identifiants Sellsy refusés (' + r.status + ') : ' + (await r.text()).slice(0, 300));
    this.token = (await r.json()).access_token;
  }
  async call(method, path, body) {
    await this.auth();
    for (let k = 0; k < 3; k++) {
      const r = await fetch(API + path, {
        method, headers: { Authorization: 'Bearer ' + this.token, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (r.status === 429 && k < 2) { await new Promise(res => setTimeout(res, 2000)); continue; }
      const txt = await r.text();
      if (!r.ok) throw new Error(method + ' ' + path + ' → ' + r.status + ' ' + txt.slice(0, 600));
      return txt ? JSON.parse(txt) : {};
    }
  }
  async taxId(rate, def) {
    if (!this.taxes) {
      this.taxes = {};
      for (const t of (await this.call('GET', '/taxes?limit=100')).data || []) {
        if (t.is_active) { const k = Number(t.rate).toFixed(1); if (!(k in this.taxes)) this.taxes[k] = t.id; }
      }
    }
    const key = v => { const x = parseFloat(String(v ?? '').replace(',', '.').replace('%', '')); return isNaN(x) ? null : x.toFixed(1); };
    const d = key(def) || '5.5';
    return this.taxes[key(rate) || d] || this.taxes[d];
  }
  async search(q, type) {
    const r = await this.call('GET', '/search?' + new URLSearchParams({ q, limit: '20' }) + '&type%5B%5D=' + type);
    return r.data || [];
  }
  async address(kind, id, c) {
    if (!c.adresse && !c.ville) return;
    await this.call('POST', `/${kind}/${id}/addresses`, {
      name: 'Adresse principale', address_line_1: c.adresse || '-', postal_code: c.cp || '', city: c.ville || '',
      country_code: 'FR', is_invoicing_address: true, is_delivery_address: true,
    });
  }
  /* retourne [id, type, créé ?] */
  async client(c) {
    if (c.sellsyId) return [Number(c.sellsyId), c.sellsyType || 'individual', false];
    if (c.societe) {
      if (!c.forceNew) {
        const k = norm(c.societe);
        for (const h of await this.search(c.societe, 'company')) {
          const o = h.object || {};
          if (o.type === 'company' && norm(h.name || h.company_name) === k) return [o.id, 'company', false];
        }
      }
      const co = await this.call('POST', '/companies', clean({ type: 'prospect', name: c.societe, email: c.email, phone_number: phone(c.tel) }));
      await this.address('companies', co.id, c);
      return [co.id, 'company', true];
    }
    if (!c.forceNew) {
      if (c.email) {
        const r = await this.call('POST', '/individuals/search?limit=5', { filters: { email: c.email } });
        if (r.data && r.data.length) return [r.data[0].id, 'individual', false];
      }
      if (c.nom) {
        const mob = phone(c.tel);
        for (const h of await this.search(c.nom, 'individual')) {
          const o = h.object || {};
          const sameName = norm(h.last_name) === norm(c.nom) && (!c.prenom || norm(h.first_name) === norm(c.prenom));
          const sameTel = mob && phone(h.mobile_number || h.phone_number) === mob;
          if (o.type === 'individual' && sameName && (sameTel || !mob)) return [o.id, 'individual', false];
        }
      }
    }
    const ind = await this.call('POST', '/individuals', clean({
      type: 'prospect', last_name: c.nom || 'Client', first_name: c.prenom,
      civility: String(c.civilite || '').startsWith('Mme') ? 'mrs' : 'mr', email: c.email, mobile_number: phone(c.tel),
    }));
    await this.address('individuals', ind.id, c);
    return [ind.id, 'individual', true];
  }
}

/* ---------- e-mail (fiches techniques) ---------- */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? String(u) : null;
let mailer = null;
function getMailer(env) {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS)
    throw new Error("Envoi d'e-mail non configuré : ajoutez BREVO_API_KEY (ou SMTP_HOST, SMTP_USER, SMTP_PASS) dans les variables Railway");
  if (!mailer) {
    const port = Number(env.SMTP_PORT || 465);
    mailer = nodemailer.createTransport({ host: env.SMTP_HOST, port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
  }
  return mailer;
}
const STAGE = new Map(); // upload_id -> { name, total, parts[], at }
function stagePut(a) {
  const id = String(a.upload_id || ''); if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('upload_id invalide');
  const total = Number(a.total), index = Number(a.index), chunk = String(a.chunk || '').replace(/\s+/g, '');
  if (!(total >= 1 && total <= 60) || !(index >= 0 && index < total)) throw new Error('Découpage invalide');
  if (!/^[A-Za-z0-9+/=]*$/.test(chunk) || chunk.length > 420000) throw new Error('Morceau invalide');
  const now = Date.now(); for (const [k, v] of STAGE) if (now - v.at > 3600e3) STAGE.delete(k);
  if (STAGE.size > 200) throw new Error('Trop de pièces jointes en attente');
  let e = STAGE.get(id); if (!e || e.total !== total) { e = { name: String(a.name || 'document.pdf'), total, parts: new Array(total).fill(null), at: now }; STAGE.set(id, e); }
  e.parts[index] = chunk; e.at = now;
  const size = e.parts.reduce((t, p) => t + (p ? p.length : 0), 0); if (size * 0.75 > 10 * 1048576) { STAGE.delete(id); throw new Error('Pièce jointe trop lourde (10 Mo maximum)'); }
  return { received: e.parts.filter(Boolean).length, total };
}
function stageGet(ids) {
  return (Array.isArray(ids) ? ids : []).slice(0, 10).map(id => {
    const e = STAGE.get(String(id)); if (!e) throw new Error('Pièce jointe introuvable ou expirée : ' + id);
    if (e.parts.some(p => p === null)) throw new Error('Pièce jointe incomplète : ' + e.name);
    return { name: e.name, content: e.parts.join('') };
  });
}
function cleanAttachments(a) {
  if (!Array.isArray(a) || !a.length) return [];
  let tot = 0;
  const out = a.slice(0, 10).map(x => {
    const name = String((x && x.name) || 'document.pdf').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120);
    const content = String((x && x.content) || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!/\.(pdf|png|jpe?g)$/i.test(name)) throw new Error('Pièce jointe refusée (PDF ou image uniquement) : ' + name);
    if (!content || !/^[A-Za-z0-9+/=]+$/.test(content)) throw new Error('Pièce jointe illisible : ' + name);
    tot += content.length * 0.75; return { name, content };
  });
  if (tot > 10 * 1024 * 1024) throw new Error('Pièces jointes trop lourdes (' + (tot / 1048576).toFixed(1) + ' Mo, 10 Mo maximum)');
  return out;
}
const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]+$/;
function emailList(v, label) {
  const a = (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map(x => String(x || '').trim()).filter(Boolean);
  a.forEach(x => { if (!EMAIL_RE.test(x)) throw new Error('Adresse e-mail invalide (' + label + ') : ' + x); });
  if (a.length > 10) throw new Error('10 adresses maximum (' + label + ')');
  return [...new Set(a.map(x => x.toLowerCase()))];
}
async function sendEstimateEmail(env, { to, name, est, items, attachments, subject: subj, message, includeItems, toMore, bcc }) {
  if (!to) throw new Error('Adresse e-mail du client absente');
  const lines = (items || []).filter(r => r && r.type !== 'title').map(r => {
    const fiche = safeUrl(r.fiche_technique || r.datasheet_url);
    return `<tr><td>${esc(r.nom || r.description || 'Article')}</td><td style="text-align:center">${esc(r.qte ?? r.quantity ?? 1)}</td>` +
      `<td>${fiche ? `<a href="${esc(fiche)}">Fiche technique</a>` : '—'}</td></tr>`;
  }).join('');
  const lien = safeUrl(est.public) || safeUrl(est.pdf);
  const table = lines ? `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse"><tr style="background:#f2f2f2"><th>Article</th><th>Qté</th><th>Fiche technique</th></tr>${lines}</table>` : '';
  const custom = String(message || '').trim();
  const html = custom ? custom.split(/\n\s*\n/).map(p => '<p>' + esc(p.trim()).replace(/\n/g, '<br>') + '</p>').join('\n') +
    (lien ? `\n<p>👉 <a href="${esc(lien)}"><b>Consulter et signer mon devis en ligne</b></a></p>` : '') + (includeItems ? '\n' + table : '')
  : `<p>Bonjour${name ? ' ' + esc(name) : ''},</p>
<p>Veuillez trouver ci-joint votre devis <b>${esc(est.number || est.id)}</b>${est.subject ? ' (' + esc(est.subject) + ')' : ''}${lien ? ` (également consultable en ligne : <a href="${esc(lien)}">consulter le devis</a>)` : ''}.</p>
${(attachments || []).length ? `<p>Vous trouverez en pièces jointes : ${(attachments || []).map(x => esc(x.name.replace(/\.[a-z]+$/i, ''))).join(', ')}.</p>` : ''}
${lines ? `<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse"><tr style="background:#f2f2f2"><th>Article</th><th>Qté</th><th>Fiche technique</th></tr>${lines}</table>` : ''}
<p>Cordialement,<br><b>ENERGETIK FRANCE</b><br>02 40 45 79 33 · <a href="mailto:contact@energetikfrance.fr">contact@energetikfrance.fr</a></p>`;
  const subject = String(subj || '').trim().slice(0, 200) || ('Votre devis ENERGETIK FRANCE ' + (est.number || ''));
  const from = env.FROM_EMAIL || env.SMTP_USER || 'contact@energetikfrance.fr';
  if (env.BREVO_API_KEY) {
    // Envoi par l'API HTTPS de Brevo (le SMTP est bloqué sur les offres Railway hors Pro)
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', signal: ctl.signal,
        headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.assign({ sender: { name: env.FROM_NAME || 'ENERGETIK FRANCE', email: from }, replyTo: { email: from, name: 'ENERGETIK FRANCE' }, to: [{ email: to, name: name || undefined }, ...(toMore || []).filter(x => x !== String(to).toLowerCase()).map(email => ({ email }))], subject, htmlContent: html }, (bcc || []).length ? { bcc: bcc.map(email => ({ email })) } : {}, (attachments || []).length ? { attachment: attachments } : {})),
      });
      const txt = await r.text();
      if (!r.ok) throw new Error('Brevo ' + r.status + ' : ' + txt.slice(0, 300));
      return (JSON.parse(txt || '{}').messageId) || 'brevo';
    } finally { clearTimeout(t); }
  }
  const info = await getMailer(env).sendMail({ from, to: [to, ...(toMore || [])].join(', '), bcc: (bcc || []).join(', ') || undefined, subject, html, attachments: (attachments || []).map(x => ({ filename: x.name, content: Buffer.from(x.content, 'base64') })) });
  return info.messageId;
}


const FINAL_STATUS = ['accepted', 'refused', 'cancelled', 'advanced', 'invoiced', 'partialinvoiced'];
const eurFr = v => Number(v || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
async function sendRelanceEmail(env, { to, name, est, bcc }) {
  if (!to) throw new Error('Adresse e-mail du client absente');
  const expired = est.status === 'expired';
  const lien = expired ? null : safeUrl(est.public);
  const d = est.date ? new Date(est.date + 'T12:00:00') : null, jours = d ? Math.round((Date.now() - d) / 864e5) : 7;
  const quand = !d || jours <= 10 ? 'Il y a une semaine' : 'Le ' + d.getDate() + (d.getDate() === 1 ? 'er' : '') + ' ' + MOIS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '');
  // PDF du devis joint (le lien de téléchargement Sellsy expire au bout de quelques minutes)
  let attachment = [];
  if (est.pdf) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(est.pdf, { signal: ctl.signal }); clearTimeout(tm);
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.ok && buf.slice(0, 4).toString() === '%PDF') attachment = [{ name: 'Devis ' + String(est.number).replace(/[\\/:*?"<>|]+/g, '_') + '.pdf', content: buf.toString('base64') }];
    } catch (e) { /* relance envoyée sans pièce jointe */ }
  }
  const html = `<p>Bonjour${name ? ' ' + esc(name) : ''},</p>
<p>${esc(quand)}, nous vous avons transmis notre devis n° <b>${esc(est.number)}</b> d'un montant de <b>${esc(eurFr(est.ttc))} TTC</b>${attachment.length ? ' (vous le retrouverez en pièce jointe)' : ''}.</p>
<p>Avez-vous pu en prendre connaissance ? Nous restons à votre disposition pour répondre à vos questions ou ajuster la proposition si besoin.</p>
${expired ? '<p>La durée de validité de ce devis étant dépassée, nous pouvons vous en adresser une version actualisée sur simple demande.</p>' : ''}
<p>N'hésitez pas à revenir vers nous pour nous tenir informés de l'avancement de votre projet, même si votre décision n'est pas encore prise.</p>
${lien ? `<p>👉 <a href="${esc(lien)}"><b>Consulter et signer mon devis en ligne</b></a></p>` : ''}
<p>Vous pouvez simplement répondre à cet e-mail ou nous appeler au <b>02 40 45 79 33</b>.</p>
<p>Cordialement,<br><b>L'équipe ENERGETIK FRANCE</b><br>13 rue de la Dutée — 44800 Saint-Herblain<br>02 40 45 79 33 · <a href="mailto:contact@energetikfrance.fr">contact@energetikfrance.fr</a></p>`;
  return sendMail(env, { to, name, subject: 'Votre devis ENERGETIK FRANCE n° ' + est.number, html, attachment, bcc });
}
async function sendMail(env, { to, name, subject, html, attachment, bcc }) {
  const from = env.FROM_EMAIL || env.SMTP_USER || 'contact@energetikfrance.fr';
  if (env.BREVO_API_KEY) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', signal: ctl.signal,
        headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.assign({ sender: { name: env.FROM_NAME || 'ENERGETIK FRANCE', email: from }, replyTo: { email: from, name: 'ENERGETIK FRANCE' }, to: [{ email: to, name: name || undefined }], subject, htmlContent: html }, (attachment || []).length ? { attachment } : {}, (bcc || []).length ? { bcc: bcc.map(email => ({ email })) } : {})),
      });
      const txt = await r.text();
      if (!r.ok) throw new Error('Brevo ' + r.status + ' : ' + txt.slice(0, 300));
      return (JSON.parse(txt || '{}').messageId) || 'brevo';
    } finally { clearTimeout(t); }
  }
  const info = await getMailer(env).sendMail({ from, to, subject, html });
  return info.messageId;
}

function summary(e) {
  const a = e.amounts || {}, rel = (e.related || [])[0] || {}, pl = e.public_link;
  return {
    id: e.id, number: e.number, status: e.status, date: e.date,
    ht: Number(a.total_excl_tax || 0), ttc: Number(a.total || a.total_incl_tax || 0), name: e.company_name || '',
    relType: rel.type, relId: rel.id, pdf: e.pdf_link || null,
    public: pl && typeof pl === 'object' ? (pl.enabled ? pl.url : null) : (pl || null), subject: e.subject || '',
  };
}


/* Complète le descriptif d'un article (superficie, chaudière remplacée, n° EPREL) */
const DOTS = '(?:\\.|…|&hellip;|&nbsp;|\\u00a0| )*(?:\\.|…|&hellip;){3,}(?:\\.|…|&hellip;|&nbsp;|\\u00a0)*';
function fillDesc(html, f) {
  let d = String(html || '');
  const txt = v => esc(String(v).trim());
  if (f.superficie) d = d.replace(new RegExp('(Superficie de la maison\\s*:\\s*(?:</strong>)?\\s*)' + DOTS, 'i'), '$1' + txt(f.superficie).replace(/\s*m(²|2)?$/i, '') + ' m²');
  if (f.chaudiere) d = d.replace(new RegExp("(en remplacement d['’]une chaudi(?:è|&egrave;)re\\s*)" + DOTS, 'i'), '$1' + txt(f.chaudiere));
  if (f.eprel && !/EPREL/i.test(d)) {
    const line = "<strong>N° d'enregistrement EPREL : </strong>" + txt(f.eprel) + '<br />';
    const m = d.match(/<strong>\s*R(?:é|&eacute;)f(?:é|&eacute;)rence\s*:\s*<\/strong>[^<]*<br\s*\/?>/i);
    d = m ? d.replace(m[0], m[0] + line) : d + (d ? '<br />' : '') + line;
  }
  return d;
}

async function createEstimate(env, job) {
  if (!job || typeof job !== 'object') throw new Error('Demande de devis absente');
  const rows0 = Array.isArray(job.rows) ? job.rows : [];
  if (!rows0.some(r => r && r.type !== 'title')) throw new Error('Aucune ligne de devis');
  const sy = new Sellsy(env);
  const [cid, ctype, created] = await sy.client(job.client || {});
  const rows = [];
  for (const r of rows0) {
    if (r.type === 'title') { rows.push({ type: 'title', text: r.text || '' }); continue; }
    const row = { quantity: String(r.qte || 1), unit_amount: Number(r.pu || 0).toFixed(2), tax_id: await sy.taxId(r.tva, job.tvaDefaut || '5.5') };
    if (r.sellsyId) {
      Object.assign(row, { type: 'catalog', related: { type: 'product', id: Number(r.sellsyId) } });
      if (r.fill && typeof r.fill === 'object') {
        try {
          const it = await sy.call('GET', '/items/' + Number(r.sellsyId));
          const d = fillDesc(it.description || '', r.fill);
          if (d && d !== it.description) Object.assign(row, { reference: it.reference || undefined, description: d });
        } catch (e) { /* description du catalogue conservée */ }
      }
    }
    else Object.assign(row, clean({ type: 'single', reference: String(r.ref || '').slice(0, 100), description: r.nom || '' }));
    rows.push(row);
  }
  const body = {
    date: job.date || new Date().toISOString().slice(0, 10), subject: job.subject || '', note: job.note || '',
    currency: 'EUR', related: [{ type: ctype, id: cid }], rows,
  };
  const e0 = await sy.call('POST', '/estimates', body);
  const e = await sy.call('GET', '/estimates/' + e0.id);
  return Object.assign(summary(e), { clientId: cid, clientType: ctype, clientCree: created });
}

/* ---------- MCP (JSON-RPC 2.0 sur HTTP) ---------- */
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(env, m) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return err(m && m.id !== undefined ? m.id : null, -32600, 'Requête invalide');
  const isNotif = m.id === undefined || m.id === null;
  switch (m.method) {
    case 'initialize':
      return ok(m.id, {
        protocolVersion: (m.params && m.params.protocolVersion) || PROTO,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sellsy-odys', title: 'Sellsy Odys', version: VERSION },
        instructions: "Connecteur Sellsy d'Odys (ENERGETIK FRANCE) : création immédiate des devis.",
      });
    case 'ping': return isNotif ? null : ok(m.id, {});
    case 'tools/list': return ok(m.id, { tools: TOOLS });
    case 'tools/call': {
      const name = m.params && m.params.name, args = (m.params && m.params.arguments) || {};
      try {
        if (name === 'create_estimate') {
          const s = await createEstimate(env, args.job);
          if (args.job && args.job.send_email) {
            try {
              const c = args.job.client || {};
              await sendEstimateEmail(env, { to: c.email, name: [c.prenom, c.nom].filter(Boolean).join(' ') || c.societe, est: s, items: args.job.rows });
              s.emailEnvoye = true;
            } catch (e) { s.emailEnvoye = false; s.emailErreur = String(e && e.message || e).slice(0, 300); }
          }
          return ok(m.id, { content: [{ type: 'text', text: 'Devis ' + s.number + ' créé dans Sellsy : ' + s.ttc.toFixed(2) + ' € TTC' }], structuredContent: s, isError: false });
        }
        if (name === 'send_estimate' && args.stage_chunk && typeof args.stage_chunk === 'object') {
          // dépôt d'un morceau de pièce jointe via l'outil existant (les clients qui n'ont pas encore l'outil stage_attachment)
          const r = stagePut(args.stage_chunk);
          return ok(m.id, { content: [{ type: 'text', text: 'Morceau ' + (Number(args.stage_chunk.index) + 1) + '/' + r.total + ' reçu (rien n\'a été envoyé)' }], structuredContent: Object.assign({ staged: true }, r), isError: false });
        }
        if (name === 'send_estimate') {
          const sy = new Sellsy(env), eid = Number(args.estimate_id);
          let att = cleanAttachments([...(args.attachments || []), ...stageGet(args.attachment_ids)]);
          const toMore = emailList(args.to_emails, 'destinataires'), bcc = emailList(args.bcc_emails, 'copie cachée');
          emailList([args.client_email], 'client');
          let est = summary(await sy.call('GET', '/estimates/' + eid));
          const wasDraft = est.status === 'draft';
          // PDF du devis joint à l'e-mail (le lien de téléchargement Sellsy expire au bout de quelques minutes)
          if (args.attach_pdf !== false && est.pdf) {
            const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
            try {
              const r = await fetch(est.pdf, { signal: ctl.signal });
              if (!r.ok) throw new Error('HTTP ' + r.status);
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length < 100 || buf.slice(0, 4).toString() !== '%PDF') throw new Error('fichier reçu non PDF');
              att.unshift({ name: 'Devis ' + String(est.number || eid).replace(/[\\/:*?"<>|]+/g, '_') + '.pdf', content: buf.toString('base64') });
            } catch (e) { throw new Error('PDF du devis ' + est.number + ' introuvable dans Sellsy (' + String(e && e.message || e).slice(0, 120) + ') : rien n\'a été envoyé'); }
            finally { clearTimeout(tm); }
          }
          est.pdf = null; // jamais de lien de téléchargement temporaire dans l'e-mail
          if (wasDraft && args.mark_sent === false) est.public = null; // envoi de test : le lien client ne s'ouvre pas tant que le devis est brouillon
          const id = await sendEstimateEmail(env, { to: args.client_email, name: args.client_name, est, items: args.items, attachments: att, toMore, bcc, subject: args.subject, message: args.message, includeItems: args.include_items === undefined ? !args.message : !!args.include_items });
          (args.attachment_ids || []).forEach(k => STAGE.delete(String(k)));
          // Une fois l'e-mail parti, le devis brouillon passe au statut « Envoyé » dans Sellsy (sauf envoi de test)
          let statut = est.status, statutErreur = '';
          if (wasDraft && args.mark_sent !== false) {
            try { await sy.call('PUT', '/estimates/' + eid + '/status', { status: 'sent' }); statut = 'sent'; }
            catch (e) { statutErreur = String(e && e.message || e).slice(0, 200); }
          }
          return ok(m.id, { content: [{ type: 'text', text: 'Devis ' + est.number + ' envoyé à ' + [args.client_email, ...toMore].join(', ') + (bcc.length ? ' (Cci : ' + bcc.join(', ') + ')' : '') }], structuredContent: { ok: true, number: est.number, messageId: id, to: [args.client_email, ...toMore], bcc, status: statut, statusError: statutErreur }, isError: false });
        }
        if (name === 'stage_attachment') {
          const r = stagePut(args);
          return ok(m.id, { content: [{ type: 'text', text: 'Morceau ' + (Number(args.index) + 1) + '/' + r.total + ' reçu' }], structuredContent: r, isError: false });
        }
        if (name === 'send_relance') {
          const est = summary(await new Sellsy(env).call('GET', '/estimates/' + Number(args.estimate_id)));
          if (FINAL_STATUS.includes(est.status) || est.status === 'draft') {
            return ok(m.id, { content: [{ type: 'text', text: 'Pas de relance : devis ' + est.number + ' au statut ' + est.status }], structuredContent: { ok: true, skipped: true, status: est.status, number: est.number }, isError: false });
          }
          const id = await sendRelanceEmail(env, { to: args.client_email, name: args.client_name, est, bcc: emailList(args.bcc_emails, 'copie cachée') });
          return ok(m.id, { content: [{ type: 'text', text: 'Relance du devis ' + est.number + ' envoyée à ' + args.client_email }], structuredContent: { ok: true, skipped: false, status: est.status, number: est.number, messageId: id }, isError: false });
        }
        if (name === 'catalog_api') {
          const meth = String(args.method || 'GET').toUpperCase(), path = String(args.path || '');
          if (!['GET', 'POST', 'PUT', 'PATCH'].includes(meth)) throw new Error('Méthode non autorisée');
          const readOnly = /^\/(individuals|companies|contacts|estimates|search)(\/|\?|$)/.test(path);
          const estEdit = (meth === 'PUT' || meth === 'PATCH') && /^\/estimates\/\d+$/.test(path);
          const estStatus = meth === 'PUT' && /^\/estimates\/\d+\/status$/.test(path);
          if (path.includes('..') || !(/^\/(items|taxes|units)(\/|\?|$)/.test(path) || estEdit || estStatus || (readOnly && meth === 'GET') || (meth === 'POST' && /^\/(individuals|companies|estimates)\/search(\?|$)/.test(path)))) throw new Error('Chemin non autorisé : ' + path);
          if (estEdit) { const cur = await new Sellsy(env).call('GET', path); if (cur.status !== 'draft') throw new Error('Seul un devis en brouillon peut être modifié (statut : ' + cur.status + ')'); }
          const r = await new Sellsy(env).call(meth, path, meth === 'GET' ? undefined : (args.body || {}));
          return ok(m.id, { content: [{ type: 'text', text: JSON.stringify(r).slice(0, 60000) }], structuredContent: r, isError: false });
        }
        if (name === 'ping') {
          const sy = new Sellsy(env); await sy.auth();
          return ok(m.id, { content: [{ type: 'text', text: 'Connexion Sellsy OK' }], structuredContent: { ok: true }, isError: false });
        }
        return err(m.id, -32602, 'Outil inconnu : ' + name);
      } catch (e) {
        return ok(m.id, { content: [{ type: 'text', text: String(e && e.message || e).slice(0, 900) }], isError: true });
      }
    }
    default:
      if (isNotif) return null; // notifications/initialized, notifications/cancelled…
      return err(m.id, -32601, 'Méthode inconnue : ' + m.method);
  }
}

function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------- Serveur HTTP (Express) ---------- */
const env = process.env;
const PORT = env.PORT || 8080;
const log = (...a) => console.log('[' + new Date().toISOString() + ']', ...a);

const app = express();
app.use(express.json({ limit: '15mb' }));

app.get('/', (req, res) => res.json({ service: 'Sellsy-Odys-MCP', version: VERSION }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const keyOk = req => !!env.ODYS_KEY && safeEq(req.params.key || '', env.ODYS_KEY);

app.all('/mcp/:key', async (req, res) => {
  if (!keyOk(req)) return res.status(404).send('Not found');
  if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json(err(null, -32700, 'JSON invalide'));
  try {
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(x => handle(env, x)))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const tool = body.method === 'tools/call' ? ' ' + (body.params && body.params.name) : '';
    log('MCP', body.method + tool);
    const r = await handle(env, body);
    if (r && r.result && r.result.isError) log('Erreur outil :', r.result.content[0].text);
    else if (r && r.result && r.result.structuredContent && r.result.structuredContent.number)
      log('Devis créé :', r.result.structuredContent.number, '(id ' + r.result.structuredContent.id + ')');
    return r ? res.json(r) : res.status(202).end();
  } catch (e) {
    log('ERREUR /mcp :', e && e.message);
    return res.status(500).json(err(body.id ?? null, -32603, String(e && e.message || e)));
  }
});

// JSON mal formé
app.use((e, req, res, next) => res.status(400).json(err(null, -32700, 'JSON invalide')));

app.listen(PORT, () => {
  log('Serveur Sellsy-Odys-MCP ' + VERSION + ' démarré sur le port ' + PORT);
  log('Sellsy : ' + (env.SELLSY_ID && env.SELLSY_SECRET ? 'identifiants présents' : 'IDENTIFIANTS MANQUANTS'));
  if (!env.ODYS_KEY) log('ODYS_KEY MANQUANTE : toutes les requêtes /mcp seront refusées');
  else if (env.ODYS_KEY.length < 24) log('ATTENTION : ODYS_KEY trop courte, utilisez au moins 24 caractères aléatoires');
});

export default app;
