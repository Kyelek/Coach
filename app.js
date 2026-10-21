'use strict';

/* ============================================================
   Estado y persistencia (todo se guarda en este dispositivo)
   ============================================================ */
const STORE_KEY = 'coach.v1';

const pad = n => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);
const toMin = hhmm => { const [h, m] = (hhmm || '0:0').split(':').map(Number); return h * 60 + m; };
const fmtMin = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const DAY_SHORT = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];

function defaultState() {
  return {
    profile: null,
    apiKey: '',
    model: '',
    startDate: dateKey(),
    days: {},          // fecha -> { routine:{}, workout:{}, cigs:[timestamps], water:0 }
    fridge: '',
    menu: null,        // { created, days:[...], shopping:[...], tips }
    shopChecked: {},
    apps: [],          // candidaturas
    chat: [],
    dailyTip: {},      // fecha -> texto
    cv: ''
  };
}

let S;
try { S = Object.assign(defaultState(), JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
catch { S = defaultState(); }
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { toast('No se pudo guardar: ' + e.message); } };

function today() {
  const k = dateKey();
  if (!S.days[k]) S.days[k] = { routine: {}, workout: {}, cigs: [], water: 0 };
  const d = S.days[k];
  d.routine ||= {}; d.workout ||= {}; d.cigs ||= []; d.water ||= 0;
  return d;
}
const dayIndex = () => Math.max(0, daysBetween(S.startDate, dateKey()));
const weekIndex = () => Math.floor(dayIndex() / 7);

/* ============================================================
   Utilidades de UI
   ============================================================ */
const $ = sel => document.querySelector(sel);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function md(text) {
  // Markdown mínimo y seguro: negritas, cursivas, listas, títulos y párrafos.
  const lines = esc(text).split(/\r?\n/);
  let html = '', list = null;
  const inline = s => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>');
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    let m;
    if (!l) { close(); continue; }
    if ((m = l.match(/^[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = l.match(/^\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
    close();
    if ((m = l.match(/^#{1,4}\s+(.*)/))) { html += `<h3>${inline(m[1])}</h3>`; continue; }
    html += `<p>${inline(l)}</p>`;
  }
  close();
  return html;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

let modalCleanup = null;
function openModal(html, onClose) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.remove('hidden');
  modalCleanup = onClose || null;
}
function closeModal() {
  $('#modal').classList.add('hidden');
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
}
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });

/* ============================================================
   IA: Google Gemini (clave gratuita de aistudio.google.com)
   ============================================================ */
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];

async function listFlashModels(key) {
  const r = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!r.ok) throw new Error(r.status === 400 || r.status === 403 ? 'Clave no válida' : `Error ${r.status}`);
  const data = await r.json();
  const ver = n => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /flash/.test(n) && !/(image|tts|audio|live|thinking|exp|preview|embedding|8b)/.test(n))
    .sort((a, b) => (ver(b) - ver(a)) || (/lite/.test(a) - /lite/.test(b)) || a.length - b.length);
}

function modelCandidates() {
  const list = [S.model, ...FALLBACK_MODELS].filter(Boolean);
  return [...new Set(list)];
}

async function ai({ system, messages, json = false, temperature = 0.8 }) {
  if (!S.apiKey) { openSettings(true); throw new Error('Falta la clave de Gemini'); }
  if (!navigator.onLine) throw new Error('Sin conexión a internet');
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] })),
    generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) }
  };
  let lastErr;
  for (const model of modelCandidates()) {
    try {
      const r = await fetch(`${GEMINI}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.apiKey },
        body: JSON.stringify(body)
      });
      if (r.status === 404 || r.status === 429 || r.status >= 500) {
        lastErr = new Error(r.status === 429 ? 'Has llegado al límite gratuito por ahora. Espera un minuto y reintenta.' : `Modelo ${model} no disponible`);
        continue;
      }
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error?.message || `Error ${r.status}`);
      const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (!text) throw new Error('La IA no devolvió respuesta. Prueba de nuevo.');
      if (S.model !== model) { S.model = model; save(); }
      if (!json) return text;
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch (e) {
      lastErr = e;
      if (!(e instanceof TypeError)) break; // TypeError = fallo de red; el resto no se arregla cambiando de modelo
    }
  }
  throw lastErr || new Error('No se pudo contactar con la IA');
}

function coachSystem(extra = '') {
  const p = S.profile || {};
  const d = today();
  const done = routineFor().filter(r => d.routine[r.id]).length;
  return `Eres "Coach", un entrenador personal y de vida cercano, directo y motivador. Hablas en español de España, tuteas, frases cortas, sin sermones. Das pasos concretos y pequeños. Celebras los avances y no juzgas las recaídas.
Usa listas cortas cuando ayuden. No uses tablas. Respuestas breves (máx. ~180 palabras) salvo que te pidan algo largo.
Si aparece algo médico serio (dolor en el pecho, mareos fuertes, síntomas de abstinencia severos, ideas de hacerse daño) recomienda acudir a un profesional o al 112.

DATOS DEL USUARIO:
- Nombre: ${p.name || '?'}; edad: ${p.age || '?'}; peso: ${p.weight || '?'} kg; altura: ${p.height || '?'} cm.
- Objetivo físico: perder peso. Nivel: sedentario total al empezar. Solo ejercicio con el peso corporal, sin gastar dinero.
- Horario desordenado; objetivo de levantarse a las ${p.wakeGoal || '?'}. Hoy le toca levantarse a las ${fmtMin(currentWake())}.
- Tabaco: fumaba ${p.cigs || '?'} cigarrillos/día; plan de reducción gradual en ${p.quitWeeks || 8} semanas. Límite de hoy: ${cigLimit()} cigarrillos. Lleva hoy ${d.cigs.length}.
- Comida: presupuesto muy ajustado.
- Trabajo: busca empleo de lo suyo: ${p.jobRole || '?'}. Experiencia: ${p.jobExp || '?'}. Habilidades: ${p.jobSkills || '?'}. Ciudad: ${p.city || '?'}.
- Progreso: día ${dayIndex() + 1} del plan (semana ${weekIndex() + 1}). Rutina de hoy: ${done}/${routineFor().length} tareas. Candidaturas totales: ${S.apps.length}.
- Fecha y hora actual: ${DAY_NAMES[new Date().getDay()]} ${new Date().toLocaleString('es-ES')}.
${extra}`;
}

function aiError(e) { toast(e.message || 'Error con la IA'); console.error(e); }

/* ============================================================
   Rutina diaria (ordena el horario poco a poco)
   ============================================================ */
function currentWake() {
  const p = S.profile; if (!p) return 480;
  const now = toMin(p.wakeNow), goal = toMin(p.wakeGoal);
  let diff = now - goal; if (diff < -720) diff += 1440; if (diff > 720) diff -= 1440;
  const step = 30 * weekIndex(); // cada semana, 30 min más cerca del objetivo
  if (Math.abs(diff) <= step) return goal;
  return now - Math.sign(diff) * step;
}

function routineFor() {
  const W = currentWake();
  const bed = W - 8 * 60 - 30;
  const wd = new Date().getDay();
  const restDay = wd === 0;
  return [
    { id: 'wake', t: W, label: 'Levántate a la primera, sin posponer ⏰' },
    { id: 'water', t: W + 5, label: 'Vaso grande de agua y abre la persiana' },
    { id: 'mob', t: W + 15, label: '5 min de movilidad (ver Entreno)' },
    { id: 'bfast', t: W + 30, label: 'Desayuno del menú' },
    { id: 'job1', t: W + 60, label: restDay ? 'Repasa tus candidaturas de la semana (20 min)' : 'Bloque empleo 1: busca ofertas y envía 3 candidaturas' },
    { id: 'train', t: W + 180, label: 'Entrenamiento de hoy' },
    { id: 'lunch', t: W + 300, label: 'Comida del menú' },
    { id: 'walk', t: W + 360, label: 'Paseo de 20–30 min (sin tabaco)' },
    { id: 'job2', t: W + 420, label: restDay ? 'Planifica la semana con el coach' : 'Bloque empleo 2: CV, formación o contactos (60 min)' },
    { id: 'dinner', t: W + 660, label: 'Cena ligera' },
    { id: 'screens', t: bed - 60, label: 'Pantallas fuera y deja lista la mañana' },
    { id: 'sleep', t: bed, label: 'A dormir 😴' }
  ];
}

/* ============================================================
   Entrenamiento progresivo con peso corporal
   ============================================================ */
const EX = {
  march: { n: 'Marcha en el sitio', how: 'Sube rodillas alternando, brazos activos.' },
  wallPush: { n: 'Flexiones en pared', how: 'Manos en la pared a la altura del pecho, cuerpo recto, baja el pecho hacia la pared.' },
  inclPush: { n: 'Flexiones inclinadas', how: 'Manos en una mesa firme o encimera. Cuerpo como una tabla.' },
  kneePush: { n: 'Flexiones de rodillas', how: 'Rodillas en el suelo, manos bajo los hombros, baja controlado.' },
  push: { n: 'Flexiones', how: 'Cuerpo recto, baja hasta casi tocar el suelo con el pecho.' },
  chairSquat: { n: 'Sentadilla a silla', how: 'Siéntate y levántate de una silla sin usar las manos, despacio.' },
  squat: { n: 'Sentadillas', how: 'Pies a la anchura de hombros, cadera atrás, espalda recta, talones apoyados.' },
  bridge: { n: 'Puente de glúteo', how: 'Tumbado boca arriba, rodillas dobladas, sube la cadera apretando glúteos.' },
  kneePlank: { n: 'Plancha de rodillas', how: 'Antebrazos y rodillas en el suelo, abdomen firme, sin hundir la espalda.' },
  plank: { n: 'Plancha', how: 'Antebrazos y puntas de pies, cuerpo recto de la cabeza a los talones.' },
  birdDog: { n: 'Bird-dog', how: 'A cuatro patas, estira brazo y pierna contrarios, aguanta 2 s, alterna.' },
  stepBack: { n: 'Zancada atrás asistida', how: 'Apóyate en una silla, da un paso atrás y baja la rodilla sin tocar el suelo.' },
  lunge: { n: 'Zancadas atrás', how: 'Paso atrás, ambas rodillas a 90°, vuelve empujando con la pierna de delante.' },
  jacksLow: { n: 'Jumping jacks sin salto', how: 'Abre una pierna al lado mientras subes los brazos, alterna.' },
  climbSlow: { n: 'Escaladores lentos', how: 'En posición de flexión, lleva rodillas al pecho alternando, sin prisa.' },
  burpeeNo: { n: 'Burpee sin salto', how: 'Agáchate, pies atrás a plancha, vuelve a recoger y ponte de pie.' },
  superman: { n: 'Superman', how: 'Boca abajo, eleva brazos y piernas un poco, aguanta 2 s.' }
};

const PHASES = [
  { name: 'Fase 1 · Despertar el cuerpo', weeks: [0, 1], rounds: 2, rest: 60,
    a: [['march', '1 min'], ['wallPush', '8–10'], ['chairSquat', '8–10'], ['bridge', '10'], ['kneePlank', '15 s'], ['birdDog', '6 por lado']],
    b: [['march', '1 min'], ['wallPush', '10'], ['stepBack', '5 por pierna'], ['bridge', '12'], ['superman', '8'], ['kneePlank', '20 s']] },
  { name: 'Fase 2 · Coger fuerza', weeks: [2, 4], rounds: 3, rest: 60,
    a: [['jacksLow', '45 s'], ['inclPush', '10'], ['squat', '12'], ['bridge', '15'], ['plank', '20 s'], ['birdDog', '8 por lado']],
    b: [['jacksLow', '45 s'], ['inclPush', '12'], ['stepBack', '8 por pierna'], ['superman', '10'], ['climbSlow', '30 s'], ['plank', '25 s']] },
  { name: 'Fase 3 · Quemar y tonificar', weeks: [5, 999], rounds: 3, rest: 45,
    a: [['jacksLow', '1 min'], ['kneePush', '10–12'], ['squat', '15–20'], ['lunge', '10 por pierna'], ['plank', '35 s'], ['burpeeNo', '8']],
    b: [['jacksLow', '1 min'], ['kneePush', '12'], ['squat', '20'], ['bridge', '20'], ['climbSlow', '40 s'], ['burpeeNo', '10']] }
];
const MOBILITY = ['Círculos de cuello y hombros (30 s)', 'Gato-camello a cuatro patas (8)', 'Estiramiento de cadera en zancada (30 s por lado)', 'Flexión de tronco tocando rodillas/espinillas (30 s)', 'Respiración profunda de pie (5 respiraciones)'];

const WEEK_PLAN = { 1: 'a', 2: 'walk', 3: 'b', 4: 'mob', 5: 'a', 6: 'long', 0: 'rest' };

function phase() { const w = weekIndex(); return PHASES.find(p => w >= p.weeks[0] && w <= p.weeks[1]); }
function walkMinutes() { return Math.min(25 + weekIndex() * 5, 50); }

function sessionFor(wd = new Date().getDay()) {
  const type = WEEK_PLAN[wd], ph = phase();
  if (type === 'a' || type === 'b') return { type, title: `Fuerza ${type.toUpperCase()}`, sub: `${ph.rounds} vueltas · descanso ${ph.rest} s entre vueltas`, items: ph[type].map(([k, r]) => ({ id: k, name: EX[k].n, how: EX[k].how, reps: r })) };
  if (type === 'walk') return { type, title: 'Caminata activa', sub: `${walkMinutes()} min a paso ligero (que te cueste un poco hablar)`, items: [{ id: 'walk', name: `Caminar ${walkMinutes()} min`, how: 'Si puedes, busca cuestas o escaleras.', reps: '' }] };
  if (type === 'mob') return { type, title: 'Movilidad + paseo', sub: '10 min de movilidad y 20 min caminando', items: [...MOBILITY.map((m, i) => ({ id: 'm' + i, name: m, how: '', reps: '' })), { id: 'walk', name: 'Paseo de 20 min', how: '', reps: '' }] };
  if (type === 'long') return { type, title: 'Caminata larga', sub: `${walkMinutes() + 15} min. Lleva agua, explora tu barrio`, items: [{ id: 'walk', name: `Caminar ${walkMinutes() + 15} min`, how: 'Ritmo cómodo pero constante.', reps: '' }] };
  return { type: 'rest', title: 'Descanso activo', sub: 'Hoy recuperas. Paseo suave y estiramientos.', items: MOBILITY.map((m, i) => ({ id: 'm' + i, name: m, how: '', reps: '' })) };
}

/* ============================================================
   Tabaco: reducción gradual
   ============================================================ */
function cigLimit(w = weekIndex()) {
  const p = S.profile; if (!p) return 0;
  const base = +p.cigs || 0, weeks = +p.quitWeeks || 8;
  return Math.max(0, Math.ceil(base * (1 - (w + 1) / weeks)));
}
function cigStats() {
  const p = S.profile || {}; const base = +p.cigs || 0;
  const pricePerCig = (+p.packPrice || 5.5) / (+p.packSize || 20);
  let avoided = 0;
  for (const [k, d] of Object.entries(S.days)) {
    if (k < S.startDate || !d.cigs) continue;
    avoided += Math.max(0, base - d.cigs.length);
  }
  return { avoided, saved: avoided * pricePerCig };
}

const CRAVING_TIPS = [
  'El antojo dura de 3 a 5 minutos. Ponte un temporizador y aguanta solo eso.',
  'Bebe un vaso de agua fría a sorbos lentos.',
  'Cambia de sitio: si estás sentado, levántate y da una vuelta.',
  'Mastica algo: zanahoria, chicle sin azúcar, un palito de regaliz.',
  'Haz 10 sentadillas ahora mismo. El cuerpo se olvida del cigarro.',
  'Lávate los dientes: el sabor a menta hace que fumar apetezca menos.',
  'Escribe por qué quieres dejarlo. Léelo en voz alta.',
  'Ocupa las manos: ordena algo, friega un plato, dibuja.',
  'Calcula: cada cigarro que no fumas es dinero en tu bolsillo.',
  'Llama o escribe a alguien. Hablar quita el antojo.'
];
const HEALTH_MILESTONES = [
  [20 / 1440, 'Tu pulso y tensión empiezan a normalizarse'],
  [0.5, 'El monóxido de carbono en sangre baja a niveles normales'],
  [2, 'Mejoran el olfato y el gusto'],
  [14, 'Mejora la circulación y la capacidad pulmonar'],
  [30, 'Menos tos y menos cansancio'],
  [365, 'El riesgo de infarto se reduce a la mitad']
];

/* ============================================================
   Navegación
   ============================================================ */
let currentTab = 'hoy';
const TITLES = { hoy: 'Hoy', entreno: 'Entreno', menu: 'Menú semanal', tabaco: 'Dejar de fumar', trabajo: 'Buscar trabajo', coach: 'Tu coach' };

$('#tabbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  go(b.dataset.tab);
});
$('#btnSettings').addEventListener('click', () => openSettings());

function go(tab) {
  currentTab = tab;
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#topTitle').textContent = TITLES[tab];
  render();
  window.scrollTo(0, 0);
}

function render() {
  stopRestTimer();
  view.classList.remove('chat-view');
  document.querySelector('.chat-input')?.remove();
  $('#tabbar').classList.toggle('hidden', !S.profile);
  if (!S.profile) return renderOnboarding();
  ({ hoy: renderHoy, entreno: renderEntreno, menu: renderMenu, tabaco: renderTabaco, trabajo: renderTrabajo, coach: renderCoach })[currentTab]();
}

/* ============================================================
   Onboarding / perfil
   ============================================================ */
function profileForm(p = {}) {
  return `
  <label class="field">¿Cómo te llamas?<input name="name" required value="${esc(p.name)}" autocomplete="given-name"></label>
  <div class="grid2">
    <label class="field">Edad<input name="age" type="number" inputmode="numeric" min="14" max="99" value="${esc(p.age)}"></label>
    <label class="field">Ciudad<input name="city" value="${esc(p.city)}" placeholder="Ej: Sevilla"></label>
    <label class="field">Peso (kg)<input name="weight" type="number" inputmode="decimal" step="0.1" value="${esc(p.weight)}"></label>
    <label class="field">Altura (cm)<input name="height" type="number" inputmode="numeric" value="${esc(p.height)}"></label>
  </div>
  <h3 class="mt">😴 Horario</h3>
  <div class="grid2">
    <label class="field">¿A qué hora te levantas ahora?<input name="wakeNow" type="time" required value="${esc(p.wakeNow || '11:00')}"></label>
    <label class="field">¿A qué hora te gustaría?<input name="wakeGoal" type="time" required value="${esc(p.wakeGoal || '08:00')}"></label>
  </div>
  <small>Cada semana adelantaremos 30 min hasta llegar a tu objetivo.</small>
  <h3 class="mt">🚬 Tabaco</h3>
  <div class="grid2">
    <label class="field">Cigarrillos al día<input name="cigs" type="number" inputmode="numeric" min="0" required value="${esc(p.cigs ?? 15)}"></label>
    <label class="field">Dejarlo en (semanas)<input name="quitWeeks" type="number" inputmode="numeric" min="2" max="20" value="${esc(p.quitWeeks || 8)}"></label>
    <label class="field">Precio del paquete (€)<input name="packPrice" type="number" inputmode="decimal" step="0.05" value="${esc(p.packPrice || 5.5)}"></label>
    <label class="field">Cigarrillos por paquete<input name="packSize" type="number" inputmode="numeric" value="${esc(p.packSize || 20)}"></label>
  </div>
  <label class="field">¿Por qué quieres dejarlo? (te lo recordaré en los antojos)<textarea name="why" placeholder="Por mi salud, para ahorrar, para subir escaleras sin ahogarme...">${esc(p.why)}</textarea></label>
  <h3 class="mt">💼 Trabajo</h3>
  <label class="field">¿Qué puesto buscas?<input name="jobRole" value="${esc(p.jobRole)}" placeholder="Ej: electricista, administrativo, cocinero..."></label>
  <label class="field">Tu experiencia y formación<textarea name="jobExp" placeholder="Años de experiencia, empresas, estudios...">${esc(p.jobExp)}</textarea></label>
  <label class="field">Habilidades clave<input name="jobSkills" value="${esc(p.jobSkills)}" placeholder="Ej: carnet B, Excel, inglés básico..."></label>
  <h3 class="mt">🍽️ Comida</h3>
  <label class="field">Alimentos que no te gustan o no puedes comer<input name="dislikes" value="${esc(p.dislikes)}" placeholder="Opcional"></label>`;
}
function readForm(form) {
  const o = Object.fromEntries(new FormData(form).entries());
  for (const k of ['age', 'weight', 'height', 'cigs', 'quitWeeks', 'packPrice', 'packSize']) if (o[k] !== '' && o[k] != null) o[k] = +o[k];
  return o;
}

function renderOnboarding() {
  $('#topTitle').textContent = 'Bienvenido';
  view.innerHTML = `
  <div class="card accent">
    <h1>Hola 👋 Soy tu coach</h1>
    <p>Vamos a cambiar tus hábitos poco a poco: rutina, ejercicio sin gastar, comida sana y barata, dejar el tabaco y encontrar trabajo.</p>
    <p class="muted">Todo se guarda solo en este móvil.</p>
  </div>
  <form id="onb" class="card">${profileForm()}
    <h3 class="mt">🤖 IA gratuita (Google Gemini)</h3>
    <p class="muted">Consigue tu clave gratis en <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> → "Create API key". Puedes ponerla ahora o más tarde en ⚙️.</p>
    <label class="field">Clave de API<input name="apiKey" autocomplete="off" placeholder="AIza..."></label>
    <button class="btn block mt">Empezar mi plan 🚀</button>
  </form>`;
  $('#onb').addEventListener('submit', async e => {
    e.preventDefault();
    const o = readForm(e.target);
    const key = (o.apiKey || '').trim(); delete o.apiKey;
    S.profile = o; S.startDate = dateKey();
    if (key) { S.apiKey = key; detectModel(true); }
    save(); go('hoy');
    toast('¡Plan creado! Día 1 💪');
  });
}

async function detectModel(silent) {
  try {
    const models = await listFlashModels(S.apiKey);
    if (models.length) { S.model = models[0]; save(); }
    if (!silent) toast(`Clave correcta ✅ Modelo: ${S.model}`);
    return models;
  } catch (e) { if (!silent) toast(e.message); return []; }
}

function openSettings(needKey) {
  openModal(`
    <div class="card-head"><h2>Ajustes</h2><button class="btn ghost" data-close>Cerrar</button></div>
    ${needKey ? '<div class="card warn">Para usar las funciones de IA necesitas tu clave gratuita de Gemini.</div>' : ''}
    <div class="card">
      <h3>🤖 IA (Google Gemini)</h3>
      <p class="muted">Clave gratis en <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>. Se guarda solo en este dispositivo.</p>
      <label class="field">Clave de API<input id="setKey" autocomplete="off" value="${esc(S.apiKey)}" placeholder="AIza..."></label>
      <label class="field">Modelo<select id="setModel"><option value="${esc(S.model)}">${esc(S.model || 'Automático')}</option></select></label>
      <div class="row"><button class="btn secondary small" id="btnTestKey">Guardar y comprobar</button></div>
    </div>
    <form id="profForm" class="card"><h3>👤 Mi perfil</h3>${S.profile ? profileForm(S.profile) : ''}
      <button class="btn block">Guardar perfil</button></form>
    <div class="card">
      <h3>💾 Datos</h3>
      <div class="row">
        <button class="btn secondary small" id="btnExport">Exportar copia</button>
        <label class="btn secondary small">Importar<input type="file" id="fileImport" accept="application/json" hidden></label>
        <button class="btn danger small" id="btnReset">Borrar todo</button>
      </div>
      <p class="muted mt">Día ${dayIndex() + 1} del plan · empezaste el ${parseKey(S.startDate).toLocaleDateString('es-ES')}</p>
    </div>`);
  const fillModels = models => {
    const sel = $('#setModel'); if (!sel || !models.length) return;
    sel.innerHTML = models.map(m => `<option ${m === S.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
  };
  if (S.apiKey) listFlashModels(S.apiKey).then(fillModels).catch(() => {});
  $('#setModel').addEventListener('change', e => { S.model = e.target.value; save(); toast('Modelo guardado'); });
  $('#btnTestKey').addEventListener('click', async e => {
    S.apiKey = $('#setKey').value.trim(); S.model = ''; save();
    e.target.disabled = true;
    fillModels(await detectModel(false));
    e.target.disabled = false;
  });
  $('#profForm')?.addEventListener('submit', e => {
    e.preventDefault(); S.profile = { ...S.profile, ...readForm(e.target) }; save(); closeModal(); render(); toast('Perfil guardado');
  });
  $('#btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ ...S, apiKey: '' }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `coach-${dateKey()}.json`; a.click();
  });
  $('#fileImport').addEventListener('change', async e => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      const key = S.apiKey; S = Object.assign(defaultState(), data); if (!S.apiKey) S.apiKey = key;
      save(); closeModal(); render(); toast('Datos importados');
    } catch { toast('Archivo no válido'); }
  });
  $('#btnReset').addEventListener('click', () => {
    if (!confirm('¿Seguro? Se borrará todo tu progreso.')) return;
    localStorage.removeItem(STORE_KEY); S = defaultState(); closeModal(); render();
  });
}

/* ============================================================
   HOY
   ============================================================ */
function streak() {
  // días seguidos con al menos el 60% de la rutina hecha
  let n = 0; const total = routineFor().length;
  for (let i = 0; ; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = dateKey(d); const day = S.days[k];
    const done = day ? Object.values(day.routine || {}).filter(Boolean).length : 0;
    if (done >= Math.ceil(total * 0.6)) n++;
    else if (i === 0) continue; // hoy aún está en curso
    else break;
    if (k <= S.startDate) break;
  }
  return n;
}

function renderHoy() {
  const p = S.profile, d = today(), items = routineFor();
  const done = items.filter(r => d.routine[r.id]).length;
  const pct = Math.round(done / items.length * 100);
  const limit = cigLimit(), cigs = d.cigs.length;
  const ses = sessionFor();
  const wkDone = ses.items.filter(i => d.workout[i.id]).length;
  const appsToday = S.apps.filter(a => a.date === dateKey()).length;
  const h = new Date().getHours();
  const hello = h < 13 ? 'Buenos días' : h < 21 ? 'Buenas tardes' : 'Buenas noches';
  const tip = S.dailyTip[dateKey()];

  view.innerHTML = `
  <h1>${hello}, ${esc(p.name)}</h1>
  <p class="muted">${DAY_NAMES[new Date().getDay()]} · Día ${dayIndex() + 1} · Semana ${weekIndex() + 1} · 🔥 Racha: ${streak()} días</p>

  <div class="card accent">
    <div class="card-head"><h2>💬 Tu coach dice</h2>${tip ? '<button class="btn ghost small" id="btnTip">Otro</button>' : ''}</div>
    <div id="tipBox" class="ai-out">${tip ? md(tip) : '<button class="btn small" id="btnTip">Dame el consejo de hoy</button>'}</div>
  </div>

  <div class="stat-row">
    <div class="stat"><b>${pct}%</b><small>Rutina</small></div>
    <div class="stat"><b style="color:${cigs > limit ? 'var(--danger)' : 'inherit'}">${cigs}/${limit}</b><small>Cigarrillos</small></div>
    <div class="stat"><b>${appsToday}/3</b><small>Candidaturas</small></div>
  </div>

  <div class="card">
    <div class="card-head"><h2>📋 Rutina de hoy</h2><span class="pill ${pct === 100 ? 'ok' : ''}">${done}/${items.length}</span></div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    ${fmtMin(currentWake()) !== p.wakeGoal ? `<p class="muted mt" style="font-size:.85rem">Esta semana te levantas a las <b>${fmtMin(currentWake())}</b>. Objetivo: ${esc(p.wakeGoal)}.</p>` : ''}
    <ul class="check-list" id="routine">
      ${items.map(r => `<li class="${d.routine[r.id] ? 'done' : ''}" data-id="${r.id}">
        <button class="tick" aria-label="Marcar">${d.routine[r.id] ? '✓' : ''}</button>
        <span class="time">${fmtMin(r.t)}</span><span class="lbl">${esc(r.label)}</span></li>`).join('')}
    </ul>
  </div>

  <div class="card">
    <div class="card-head"><h2>💪 ${esc(ses.title)}</h2><span class="pill ${wkDone === ses.items.length ? 'ok' : ''}">${wkDone}/${ses.items.length}</span></div>
    <p class="muted">${esc(ses.sub)}</p>
    <button class="btn secondary block" data-go="entreno">Ir al entreno</button>
  </div>

  <div class="card">
    <div class="card-head"><h2>💧 Agua</h2><span class="pill">${d.water}/8 vasos</span></div>
    <div class="row"><div class="progress grow"><div style="width:${Math.min(100, d.water / 8 * 100)}%"></div></div>
    <button class="btn small" id="btnWater">+1 vaso</button></div>
  </div>

  <div class="card">
    <div class="card-head"><h2>🚭 Tabaco</h2><span class="pill ${cigs > limit ? 'bad' : cigs === limit ? 'warn' : 'ok'}">${cigs > limit ? 'Te has pasado' : `Te quedan ${limit - cigs}`}</span></div>
    <div class="row">
      <button class="btn secondary grow" data-go="tabaco">Registrar</button>
      <button class="btn danger grow" id="btnSos">🆘 Tengo ganas</button>
    </div>
  </div>`;

  $('#routine').addEventListener('click', e => {
    const li = e.target.closest('li'); if (!li) return;
    d.routine[li.dataset.id] = !d.routine[li.dataset.id]; save(); renderHoy();
    if (d.routine[li.dataset.id] && items.every(r => d.routine[r.id])) toast('¡Rutina completa! Eres una máquina 🏆');
  });
  $('#btnWater').addEventListener('click', () => { d.water++; save(); renderHoy(); });
  $('#btnSos').addEventListener('click', openSOS);
  bindGo();
  view.querySelectorAll('#btnTip').forEach(b => b.addEventListener('click', async () => {
    $('#tipBox').innerHTML = '<span class="spinner"></span>';
    try {
      const t = await ai({ system: coachSystem(), messages: [{ role: 'user', text: 'Dame mi mensaje de coach para hoy: 2-3 frases motivadoras y UNA acción concreta y pequeña para hoy relacionada con mis objetivos (alterna entre ejercicio, tabaco, comida, horario y trabajo). Sin saludos largos.' }] });
      S.dailyTip[dateKey()] = t; save();
    } catch (e) { aiError(e); }
    renderHoy();
  }));
}

function bindGo() { view.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go))); }

/* ============================================================
   ENTRENO
   ============================================================ */
let restTimer = null;
function stopRestTimer() { if (restTimer) { clearInterval(restTimer); restTimer = null; } }

function renderEntreno() {
  const d = today(), ses = sessionFor(), ph = phase(), wd = new Date().getDay();
  const allDone = ses.items.every(i => d.workout[i.id]);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - ((wd + 6) % 7));
  const week = [1, 2, 3, 4, 5, 6, 0].map((w, i) => {
    const dt = new Date(weekStart); dt.setDate(dt.getDate() + i);
    const day = S.days[dateKey(dt)];
    const s = sessionFor(w);
    const did = day && s.items.length && s.items.every(it => day.workout?.[it.id]);
    const icon = { a: '💪', b: '💪', walk: '🚶', mob: '🧘', long: '🥾', rest: '😌' }[s.type];
    return `<div class="${w === wd ? 'today' : ''} ${did ? 'done' : ''}"><b>${did ? '✅' : icon}</b>${DAY_SHORT[w]}</div>`;
  }).join('');

  view.innerHTML = `
  <p class="muted">${esc(ph.name)} · Semana ${weekIndex() + 1}</p>
  <div class="card"><div class="week">${week}</div></div>

  <div class="card">
    <div class="card-head"><h2>${esc(ses.title)}</h2>${allDone ? '<span class="pill ok">Hecho ✅</span>' : ''}</div>
    <p class="muted">${esc(ses.sub)}</p>
    ${(ses.type === 'a' || ses.type === 'b') ? '<p style="font-size:.9rem">Calienta 3 min. Haz todos los ejercicios seguidos (descansa 15–20 s entre ellos), y repite la vuelta. Si algo duele (no confundir con esfuerzo), para.</p>' : ''}
    <div id="exList">
      ${ses.items.map(i => `<div class="ex ${d.workout[i.id] ? 'done' : ''}" data-id="${i.id}">
        <div class="ex-head"><button class="tick">${d.workout[i.id] ? '✓' : ''}</button><span class="lbl">${esc(i.name)}</span>${i.reps ? `<span class="pill">${esc(i.reps)}</span>` : ''}</div>
        ${i.how ? `<div class="ex-how">${esc(i.how)}</div>` : ''}</div>`).join('')}
    </div>
  </div>

  ${(ses.type === 'a' || ses.type === 'b') ? `
  <div class="card">
    <h2>⏱️ Temporizador de descanso</h2>
    <div class="timer" id="timer">${ph.rest}s</div>
    <div class="row"><button class="btn grow" id="btnRest">Descanso ${ph.rest} s</button><button class="btn secondary" id="btnRest30">30 s</button></div>
  </div>` : ''}

  <div class="card">
    <h2>📈 Cómo progresas</h2>
    <p style="font-size:.9rem">Semanas 1–2: despertar el cuerpo. Semanas 3–5: fuerza. Semana 6+: quemar grasa. Para perder peso, lo que más cuenta es moverte todos los días y comer bien: <b>no te saltes las caminatas</b>.</p>
    <button class="btn secondary block" id="btnAskWorkout">Pregunta al coach sobre un ejercicio</button>
  </div>`;

  $('#exList').addEventListener('click', e => {
    const ex = e.target.closest('.ex'); if (!ex) return;
    d.workout[ex.dataset.id] = !d.workout[ex.dataset.id];
    if (ses.items.every(i => d.workout[i.id])) { d.routine.train = true; toast('¡Entreno completado! 🔥'); }
    save(); renderEntreno();
  });
  const startRest = secs => {
    stopRestTimer(); let left = secs; const el = $('#timer'); el.textContent = left + 's';
    restTimer = setInterval(() => {
      left--; el.textContent = left + 's';
      if (left <= 0) { stopRestTimer(); el.textContent = '¡Vamos!'; navigator.vibrate?.([200, 100, 200]); }
    }, 1000);
  };
  $('#btnRest')?.addEventListener('click', () => startRest(ph.rest));
  $('#btnRest30')?.addEventListener('click', () => startRest(30));
  $('#btnAskWorkout').addEventListener('click', () => askCoach(`Hoy me toca "${ses.title}". `));
}

/* ============================================================
   MENÚ
   ============================================================ */
function renderMenu() {
  const m = S.menu;
  view.innerHTML = `
  <div class="card">
    <h2>🧊 ¿Qué tienes en la nevera y la despensa?</h2>
    <p class="muted" style="font-size:.9rem">Escríbelo como quieras: "huevos, arroz, 2 tomates, lentejas, pollo congelado..."</p>
    <textarea id="fridge" placeholder="Huevos, arroz, cebolla, lentejas, atún en lata, plátanos...">${esc(S.fridge)}</textarea>
    <label class="field">Presupuesto para completar la semana (€)<input id="budget" type="number" inputmode="decimal" value="${esc(S.profile.budget || 25)}"></label>
    <button class="btn block" id="btnMenu">${m ? 'Rehacer menú semanal' : 'Crear mi menú semanal'}</button>
  </div>
  <div id="menuOut">${m ? menuHtml(m) : '<p class="muted center">Aún no tienes menú. ¡Dime qué tienes y lo creo!</p>'}</div>`;

  $('#btnMenu').addEventListener('click', async e => {
    S.fridge = $('#fridge').value.trim(); S.profile.budget = +$('#budget').value || 25; save();
    if (!S.fridge) return toast('Dime al menos un par de cosas que tengas');
    e.target.disabled = true; e.target.innerHTML = '<span class="spinner"></span> Cocinando tu menú...';
    try {
      const out = await ai({
        system: coachSystem('Ahora actúas como nutricionista práctico y ahorrador.'),
        json: true, temperature: 0.7,
        messages: [{ role: 'user', text:
`Crea un menú semanal saludable para perder peso (déficit calórico moderado, unas ${S.profile.weight > 90 ? '1900' : '1700'} kcal/día orientativas), comida casera española, recetas fáciles y BARATAS.
Aprovecha al máximo lo que tengo: ${S.fridge}.
Presupuesto máximo para comprar lo que falte: ${S.profile.budget} €. ${S.profile.dislikes ? 'Evita: ' + S.profile.dislikes + '.' : ''}
Reutiliza ingredientes entre días para no desperdiciar; cocina en tandas (batch cooking) cuando ayude. Legumbres, huevos, verduras de temporada, arroz, avena, fruta.
Devuelve SOLO JSON con esta forma exacta:
{"dias":[{"dia":"Lunes","desayuno":"...","comida":"...","merienda":"...","cena":"..."}],"lista_compra":[{"item":"...","cantidad":"...","precio_aprox":1.2}],"coste_total":0,"preparacion":"consejo de batch cooking del domingo","consejos":["..."]}
7 días de lunes a domingo. En comida y cena pon el plato y entre paréntesis una mini-receta de una línea.` }]
      });
      S.menu = { created: dateKey(), ...out }; S.shopChecked = {}; save();
      toast('¡Menú listo! 🥗');
    } catch (err) { aiError(err); }
    renderMenu();
  });
  bindMenu();
}

function menuHtml(m) {
  const wd = DAY_NAMES[new Date().getDay()].toLowerCase();
  const days = m.dias || [];
  const shop = m.lista_compra || [];
  return `
  <div class="card">
    <div class="card-head"><h2>🗓️ Tu semana</h2><small>creado ${parseKey(m.created).toLocaleDateString('es-ES')}</small></div>
    ${days.map(d => `<details class="day" ${String(d.dia).toLowerCase() === wd ? 'open' : ''}>
      <summary>${esc(d.dia)}${String(d.dia).toLowerCase() === wd ? ' · hoy' : ''}</summary>
      ${['desayuno', 'comida', 'merienda', 'cena'].filter(k => d[k]).map(k => `<div class="meal"><b>${k}</b>${esc(d[k])}</div>`).join('')}
    </details>`).join('')}
  </div>
  ${shop.length ? `<div class="card">
    <div class="card-head"><h2>🛒 Lista de la compra</h2>${m.coste_total ? `<span class="pill">≈ ${(+m.coste_total).toFixed(2)} €</span>` : ''}</div>
    <ul class="check-list" id="shopList">${shop.map((s, i) => `<li class="${S.shopChecked[i] ? 'done' : ''}" data-i="${i}">
      <button class="tick">${S.shopChecked[i] ? '✓' : ''}</button>
      <span class="lbl">${esc(s.item)} <small>${esc(s.cantidad || '')}</small></span>
      ${s.precio_aprox ? `<small>${(+s.precio_aprox).toFixed(2)} €</small>` : ''}</li>`).join('')}</ul>
  </div>` : ''}
  ${m.preparacion ? `<div class="card accent"><h2>👨‍🍳 Prepara el domingo</h2><p>${esc(m.preparacion)}</p></div>` : ''}
  ${(m.consejos || []).length ? `<div class="card"><h2>💡 Consejos</h2><ul>${m.consejos.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
  <button class="btn secondary block" id="btnCookToday">¿Qué cocino hoy con lo que me queda?</button>`;
}
function bindMenu() {
  $('#shopList')?.addEventListener('click', e => {
    const li = e.target.closest('li'); if (!li) return;
    S.shopChecked[li.dataset.i] = !S.shopChecked[li.dataset.i]; save(); renderMenu();
  });
  $('#btnCookToday')?.addEventListener('click', () => askCoach('¿Qué cocino hoy? Tengo esto en la nevera: ' + (S.fridge || '...')));
}

/* ============================================================
   TABACO
   ============================================================ */
function renderTabaco() {
  const p = S.profile, d = today(), limit = cigLimit(), cigs = d.cigs.length;
  const { avoided, saved } = cigStats();
  const last = d.cigs[d.cigs.length - 1];
  const sinceMin = last ? Math.floor((Date.now() - last) / 60000) : null;
  // repartir el límite en las horas despierto
  const awakeMin = 16 * 60;
  const gap = limit > 0 ? Math.round(awakeMin / limit) : null;
  const nextAt = last && gap ? new Date(last + gap * 60000) : null;
  const pct = limit ? Math.min(100, cigs / limit * 100) : (cigs ? 100 : 0);
  const weeks = +p.quitWeeks || 8;
  const quitDate = parseKey(S.startDate); quitDate.setDate(quitDate.getDate() + (weeks - 1) * 7);
  // días sin fumar seguidos (para hitos de salud)
  let clean = 0;
  for (let i = 1; i < 400; i++) { const dt = new Date(); dt.setDate(dt.getDate() - i); const k = dateKey(dt); if (k < S.startDate) break; const dd = S.days[k]; if (dd && dd.cigs?.length === 0) clean++; else break; }

  view.innerHTML = `
  <div class="card">
    <p class="center muted">Hoy llevas</p>
    <div class="big-count">${cigs}<small> / ${limit}</small></div>
    <div class="progress mt ${cigs > limit ? 'danger' : cigs === limit ? 'warn' : ''}"><div style="width:${pct}%"></div></div>
    <p class="center mt">${limit === 0 ? '<b>Objetivo: 0 cigarrillos. ¡Eres no fumador!</b>' : cigs > limit ? 'Te has pasado del límite. No pasa nada: mañana es otro día. Para aquí.' : `Te quedan <b>${limit - cigs}</b> para hoy.`}</p>
    ${sinceMin !== null ? `<p class="center muted" style="font-size:.9rem">Último hace ${sinceMin < 60 ? sinceMin + ' min' : Math.floor(sinceMin / 60) + ' h ' + (sinceMin % 60) + ' min'}${nextAt && nextAt > new Date() ? ` · intenta aguantar hasta las <b>${pad(nextAt.getHours())}:${pad(nextAt.getMinutes())}</b>` : ''}</p>` : ''}
    <div class="row mt">
      <button class="btn secondary" id="btnUndo" ${cigs ? '' : 'disabled'}>Deshacer</button>
      <button class="btn grow" id="btnSmoke">He fumado uno</button>
    </div>
    <button class="btn danger block mt" id="btnSos">🆘 Tengo muchas ganas de fumar</button>
  </div>

  <div class="stat-row">
    <div class="stat"><b>${avoided}</b><small>cigarrillos evitados</small></div>
    <div class="stat"><b>${saved.toFixed(0)} €</b><small>ahorrados</small></div>
    <div class="stat"><b>${clean}</b><small>días sin fumar</small></div>
  </div>

  <div class="card">
    <h2>📉 Tu plan de reducción</h2>
    <p class="muted" style="font-size:.9rem">Fecha para dejarlo del todo: <b>${quitDate.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })}</b></p>
    <ul class="check-list">${Array.from({ length: weeks }, (_, w) => `<li class="${w < weekIndex() ? 'done' : ''}">
      <span class="lbl">Semana ${w + 1}${w === weekIndex() ? ' · <b>ahora</b>' : ''}</span><span class="pill ${w === weekIndex() ? 'ok' : ''}">${cigLimit(w)} al día</span></li>`).join('')}</ul>
  </div>

  ${clean > 0 || limit === 0 ? `<div class="card accent"><h2>❤️ Tu cuerpo se recupera</h2><ul>${HEALTH_MILESTONES.map(([dd, t]) => `<li>${clean >= dd ? '✅' : '⏳'} ${t}</li>`).join('')}</ul></div>` : ''}

  <div class="card">
    <h2>🧠 Trucos para reducir</h2>
    <ul>
      <li>Retrasa el primero del día: nunca en ayunas ni nada más despertar.</li>
      <li>Fuma solo fuera de casa y sin hacer otra cosa (ni móvil ni café).</li>
      <li>No compres paquetes: compra solo cuando se acabe.</li>
      <li>Identifica tus disparadores (café, después de comer, estrés) y cámbialos por un paseo o agua.</li>
      <li>Tu médico de cabecera puede ayudarte: hay tratamientos financiados por la Seguridad Social.</li>
    </ul>
    ${p.why ? `<div class="card warn"><b>Tu porqué:</b> ${esc(p.why)}</div>` : ''}
  </div>`;

  $('#btnSmoke').addEventListener('click', () => {
    d.cigs.push(Date.now()); save(); renderTabaco();
    if (d.cigs.length > limit) toast('Has superado el límite. Respira, mañana lo haces mejor.');
  });
  $('#btnUndo').addEventListener('click', () => { d.cigs.pop(); save(); renderTabaco(); });
  $('#btnSos').addEventListener('click', openSOS);
}

function openSOS() {
  const tips = [...CRAVING_TIPS].sort(() => Math.random() - .5).slice(0, 3);
  const why = S.profile?.why;
  openModal(`
    <div class="card-head"><h2>🆘 Aguanta 3 minutos</h2><button class="btn ghost" data-close>Cerrar</button></div>
    <p>El antojo es una ola: sube y baja. Respira conmigo.</p>
    <div class="breath-wrap"><div class="breath" id="breath">Inspira</div></div>
    <p class="center muted" id="sosTime">3:00</p>
    ${why ? `<div class="card warn"><b>Recuerda por qué:</b> ${esc(why)}</div>` : ''}
    <div class="card"><h3>Mientras tanto</h3><ul>${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>
    <button class="btn block" id="sosCoach">Habla con el coach</button>`, () => clearInterval(breathTimer));
  let phaseI = 0, left = 180;
  const steps = [['Inspira', 4, 1.35], ['Aguanta', 4, 1.35], ['Suelta', 6, 1]];
  const el = $('#breath'); let tick = 0;
  const apply = () => { const [t, , sc] = steps[phaseI]; el.textContent = t; el.style.transitionDuration = steps[phaseI][1] + 's'; el.style.transform = `scale(${sc})`; };
  apply();
  clearInterval(breathTimer);
  breathTimer = setInterval(() => {
    left--; tick++;
    const tEl = $('#sosTime'); if (!tEl) return clearInterval(breathTimer);
    tEl.textContent = left > 0 ? `${Math.floor(left / 60)}:${pad(left % 60)}` : '¡Lo has conseguido! 💪';
    if (tick >= steps[phaseI][1]) { tick = 0; phaseI = (phaseI + 1) % steps.length; apply(); }
    if (left <= 0) clearInterval(breathTimer);
  }, 1000);
  $('#sosCoach').addEventListener('click', () => { closeModal(); askCoach('Tengo muchísimas ganas de fumar ahora mismo. Ayúdame a aguantar.', true); });
}
let breathTimer;

/* ============================================================
   TRABAJO
   ============================================================ */
const STATUSES = ['Enviada', 'Sin respuesta', 'Entrevista', 'Rechazada', 'Oferta 🎉'];

function renderTrabajo() {
  const p = S.profile;
  const q = encodeURIComponent(p.jobRole || ''), loc = encodeURIComponent(p.city || '');
  const appsToday = S.apps.filter(a => a.date === dateKey()).length;
  const interviews = S.apps.filter(a => a.status === 'Entrevista').length;
  view.innerHTML = `
  <div class="card">
    <div class="card-head"><h2>🎯 Objetivo de hoy</h2><span class="pill ${appsToday >= 3 ? 'ok' : ''}">${appsToday}/3</span></div>
    <div class="progress"><div style="width:${Math.min(100, appsToday / 3 * 100)}%"></div></div>
    <p class="mt" style="font-size:.9rem">Envía 3 candidaturas de calidad al día. Buscar trabajo es tu trabajo ahora mismo.</p>
  </div>

  <div class="stat-row">
    <div class="stat"><b>${S.apps.length}</b><small>enviadas</small></div>
    <div class="stat"><b>${interviews}</b><small>entrevistas</small></div>
    <div class="stat"><b>${S.apps.filter(a => a.date >= dateKey(new Date(Date.now() - 6 * 86400000))).length}</b><small>esta semana</small></div>
  </div>

  <div class="card">
    <h2>🔎 Buscar ofertas</h2>
    <p class="muted" style="font-size:.9rem">${esc(p.jobRole || 'Pon tu puesto en ⚙️ Ajustes')} ${p.city ? 'en ' + esc(p.city) : ''}</p>
    <div class="grid2">
      <a class="btn secondary small" target="_blank" rel="noopener" href="https://www.infojobs.net/jobsearch/search-results/list.xhtml?keyword=${q}&normalizedJobTitleIds=&provinceIds=&cityIds=&teleworkingIds=&categoryIds=&workdayIds=&educationIds=&segmentId=&contractTypeIds=&page=1&sortBy=PUBLICATION_DATE&onlyForeignCountry=false&countryIds=17&sinceDate=ANY&subcategoryIds=">InfoJobs</a>
      <a class="btn secondary small" target="_blank" rel="noopener" href="https://www.linkedin.com/jobs/search/?keywords=${q}&location=${loc}">LinkedIn</a>
      <a class="btn secondary small" target="_blank" rel="noopener" href="https://es.indeed.com/jobs?q=${q}&l=${loc}">Indeed</a>
      <a class="btn secondary small" target="_blank" rel="noopener" href="https://www.google.com/search?q=${q}+empleo+${loc}&ibp=htl;jobs">Google Empleo</a>
    </div>
    <p class="muted mt" style="font-size:.85rem">Apúntate también como demandante en el servicio de empleo de tu comunidad: tienen ofertas y cursos gratis.</p>
  </div>

  <div class="card">
    <div class="card-head"><h2>📨 Mis candidaturas</h2><button class="btn small" id="btnAddApp">+ Añadir</button></div>
    <form id="appForm" class="hidden">
      <div class="grid2">
        <label class="field">Empresa<input name="company" required></label>
        <label class="field">Puesto<input name="role" value="${esc(p.jobRole)}"></label>
      </div>
      <label class="field">Enlace u observaciones<input name="notes"></label>
      <button class="btn block">Guardar</button>
    </form>
    <div id="appList">${S.apps.length ? [...S.apps].reverse().map(a => `
      <div class="app-item" data-id="${a.id}">
        <div class="grow"><b>${esc(a.company)}</b><small>${esc(a.role)} · ${parseKey(a.date).toLocaleDateString('es-ES')}${a.notes ? ' · ' + esc(a.notes) : ''}</small></div>
        <select data-status>${STATUSES.map(s => `<option ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button class="icon-btn" data-del aria-label="Borrar">🗑️</button>
      </div>`).join('') : '<p class="muted">Aún no hay candidaturas. ¡La primera es la más difícil!</p>'}</div>
  </div>

  <div class="card">
    <h2>🤖 Herramientas con IA</h2>
    <label class="field">Pega aquí tu CV (texto) o la oferta de trabajo<textarea id="jobText" placeholder="Pega tu CV para mejorarlo, o una oferta para escribir la carta...">${esc(S.cv)}</textarea></label>
    <div class="grid2">
      <button class="btn secondary small" data-tool="cv">Mejorar mi CV</button>
      <button class="btn secondary small" data-tool="letter">Carta para esta oferta</button>
      <button class="btn secondary small" data-tool="plan">Plan de búsqueda semanal</button>
      <button class="btn secondary small" data-tool="interview">Simular entrevista</button>
    </div>
    <div id="toolOut" class="ai-out mt"></div>
  </div>`;

  $('#btnAddApp').addEventListener('click', () => $('#appForm').classList.toggle('hidden'));
  $('#appForm').addEventListener('submit', e => {
    e.preventDefault();
    const o = Object.fromEntries(new FormData(e.target).entries());
    S.apps.push({ id: Date.now(), date: dateKey(), status: 'Enviada', ...o });
    const n = S.apps.filter(a => a.date === dateKey()).length;
    if (n >= 3) today().routine.job1 = true;
    save(); renderTrabajo();
    toast(n >= 3 ? '¡Objetivo del día cumplido! 🎯' : `¡Bien! ${n}/3 hoy`);
  });
  $('#appList').addEventListener('change', e => {
    if (!e.target.matches('[data-status]')) return;
    const a = S.apps.find(x => x.id == e.target.closest('.app-item').dataset.id);
    a.status = e.target.value; save();
    if (a.status === 'Entrevista') toast('¡Entrevista! Prepárala con el coach 💪');
  });
  $('#appList').addEventListener('click', e => {
    if (!e.target.closest('[data-del]')) return;
    const id = e.target.closest('.app-item').dataset.id;
    if (!confirm('¿Borrar esta candidatura?')) return;
    S.apps = S.apps.filter(x => x.id != id); save(); renderTrabajo();
  });

  const prompts = {
    cv: t => `Revisa y mejora mi CV para conseguir trabajo de ${p.jobRole}. Dame: 1) un perfil profesional de 3 líneas listo para copiar, 2) los 5 cambios más importantes, 3) palabras clave que deberían aparecer. Mi CV:\n${t}`,
    letter: t => `Escribe una carta de presentación breve (máx. 180 palabras), natural y nada genérica, para esta oferta. Usa mi experiencia: ${p.jobExp}. Habilidades: ${p.jobSkills}. Oferta:\n${t}`,
    plan: () => `Hazme un plan de búsqueda de empleo para esta semana como ${p.jobRole} en ${p.city}: qué hacer cada día (lunes a viernes) en 2 bloques, dónde buscar específicamente para mi sector, a quién contactar y cómo destacar.`
  };
  view.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', async () => {
    const tool = b.dataset.tool, text = $('#jobText').value.trim();
    if (tool === 'interview') return askCoach(`Simula una entrevista de trabajo para ${p.jobRole}. Hazme UNA pregunta cada vez, espera mi respuesta y dame feedback breve antes de la siguiente.`, true);
    if ((tool === 'cv' || tool === 'letter') && !text) return toast('Pega primero el texto arriba');
    if (tool === 'cv') { S.cv = text; save(); }
    const out = $('#toolOut'); out.innerHTML = '<span class="spinner"></span>';
    try {
      const r = await ai({ system: coachSystem('Ahora actúas como orientador laboral experto en el mercado español.'), messages: [{ role: 'user', text: prompts[tool](text) }], temperature: 0.6 });
      out.innerHTML = `<div class="card accent">${md(r)}<button class="btn ghost small" id="btnCopy">📋 Copiar</button></div>`;
      $('#btnCopy').addEventListener('click', () => navigator.clipboard?.writeText(r).then(() => toast('Copiado')));
    } catch (e) { out.innerHTML = ''; aiError(e); }
  }));
}

/* ============================================================
   COACH (chat)
   ============================================================ */
function askCoach(text, send = false) {
  go('coach');
  const ta = $('#chatText'); ta.value = text;
  if (send) sendChat(); else ta.focus();
}

function renderCoach() {
  view.classList.add('chat-view');
  const msgs = S.chat;
  view.innerHTML = `
  ${msgs.length ? '' : `<div class="card accent"><h2>Hola, ${esc(S.profile.name)} 👊</h2><p>Cuéntame cómo vas, pídeme ideas para cenar, ayuda con un antojo o prepara una entrevista. Estoy aquí para eso.</p></div>`}
  <div class="chat" id="chat">${msgs.map(m => `<div class="msg ${m.role}">${m.role === 'model' ? md(m.text) : esc(m.text)}</div>`).join('')}</div>
  ${msgs.length ? '<div class="center"><button class="btn ghost small" id="btnClear">Borrar conversación</button></div>' : ''}`;
  const bar = document.createElement('div');
  bar.className = 'chat-input';
  bar.innerHTML = `<div class="inner" style="flex-direction:column">
    <div class="chips" id="chips">
      ${['Tengo ganas de fumar', 'No tengo motivación', '¿Qué ceno hoy?', 'Revisa mi día', 'Me he saltado el entreno', 'Estoy agobiado con el trabajo'].map(c => `<button>${c}</button>`).join('')}
    </div>
    <div class="row" style="flex-wrap:nowrap"><textarea id="chatText" class="grow" placeholder="Escribe a tu coach..." rows="1"></textarea>
    <button class="btn" id="btnSend" aria-label="Enviar">➤</button></div></div>`;
  document.body.appendChild(bar);
  $('#btnSend').addEventListener('click', sendChat);
  $('#chatText').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); sendChat(); } });
  $('#chips').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { $('#chatText').value = b.textContent; sendChat(); } });
  $('#btnClear')?.addEventListener('click', () => { if (confirm('¿Borrar la conversación?')) { S.chat = []; save(); renderCoach(); } });
  window.scrollTo(0, document.body.scrollHeight);
}

let sending = false;
async function sendChat() {
  const ta = $('#chatText'); const text = ta.value.trim();
  if (!text || sending) return;
  sending = true; ta.value = '';
  S.chat.push({ role: 'user', text }); save();
  const chat = $('#chat');
  view.querySelector('.card.accent')?.remove();
  chat.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}</div><div class="msg model" id="typing"><span class="spinner"></span></div>`);
  window.scrollTo(0, document.body.scrollHeight);
  try {
    const reply = await ai({ system: coachSystem(), messages: S.chat.slice(-20) });
    S.chat.push({ role: 'model', text: reply });
    S.chat = S.chat.slice(-60); save();
  } catch (e) { aiError(e); S.chat.pop(); save(); ta.value = text; }
  sending = false;
  if (currentTab === 'coach') { renderCoach(); }
}

/* ============================================================
   Arranque
   ============================================================ */
// Al volver a la app (p. ej. después de medianoche) refresca la vista
document.addEventListener('visibilitychange', () => { if (!document.hidden && currentTab !== 'coach') render(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
go(TITLES[location.hash.slice(1)] ? location.hash.slice(1) : 'hoy');
