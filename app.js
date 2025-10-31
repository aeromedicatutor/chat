// app.js
// ---------- IMPORTS FIREBASE ----------
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getDatabase, ref, onChildAdded, push, set, serverTimestamp,
  onDisconnect, onValue, update, get, child
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import {
  getAuth, setPersistence, browserLocalPersistence,
  signInAnonymously, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

// ---------- APP CORE ----------
export const app  = initializeApp(firebaseConfig);
export const db   = getDatabase(app);
export const auth = getAuth(app);

// Persistência (evita “não acontece nada” após refresh/redirect)
await setPersistence(auth, browserLocalPersistence).catch(()=>{});

// ---------- HELPERS ----------
export const $  = s => document.querySelector(s);
export const $$ = s => document.querySelectorAll(s);
export const esc = s => String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
export const slug = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
export const scroll = el => { el.scrollTop = el.scrollHeight; };

// roteamento simples
function resolve(){
  const r = location.hash.replace('#/','');
  const isAdm = r === 'admin';
  $('#view-user').style.display  = isAdm ? 'none'  : 'block';
  $('#view-admin').style.display = isAdm ? 'block' : 'none';
}
window.addEventListener('hashchange', resolve); resolve();

// ========= USER =========
const loginCard   = $('#loginCard');
const chatWrap    = $('#chatWrap');
const chatTitle   = $('#chatTitle');
const chatSubtitle= $('#chatSubtitle');
const nomeInput   = $('#nomeInput');
const contatoInput= $('#contatoInput');
const assuntoInput= $('#assuntoInput');
const categoriaSelect = $('#categoriaSelect');
const msgForm     = $('#msgForm');
const msgInput    = $('#msgInput');
const messages    = $('#messages');
const btnLeave    = $('#btnLeave');

let user = { roomId:null, userLabel:null, assunto:null, categoria:null };
let roomRef = null, msgsRef = null;

function openChatUI(nome, catLabel){
  loginCard.classList.add('hidden'); chatWrap.classList.remove('hidden');
  chatTitle.textContent = `${nome} • ${catLabel} — ${user.assunto}`;
  chatSubtitle.textContent = 'Conectado';
}

function listenTyping(roomId, whoIsOther, targetEl, id='typingHint'){
  onValue(ref(db, `chats/${roomId}/status/typing/${whoIsOther}`), s=>{
    const v = !!s.val();
    let tip = document.getElementById(id);
    if(!tip){ tip=document.createElement('div'); tip.id=id; tip.className='center'; targetEl.appendChild(tip); }
    tip.textContent = v ? (whoIsOther==='admin' ? 'ADM está digitando…' : 'Usuário está digitando…') : '';
  });
}

function setTyping(roomId, who, val){
  const p = ref(db, `chats/${roomId}/status/typing/${who}`);
  set(p, !!val); onDisconnect(p).set(false);
}

async function assignAgent(roomId, categoria){ // balanceador simples
  const snap = await get(ref(db, 'agents'));
  const all  = snap.val() || {};
  const pool = Object.entries(all).filter(([uid,a])=> a?.available && a?.group===categoria)
                                  .map(([uid,a])=>({ uid, name:a.name||'Agente' }));
  if(pool.length===0){
    await update(ref(db, `chats/${roomId}`), { status:{ queue:true } });
    return;
  }
  const chatsSnap = await get(ref(db, 'chats')); const chats = chatsSnap.val()||{};
  const counts = {}; pool.forEach(p=>counts[p.uid]=0);
  Object.values(chats).forEach(c=>{
    if(c?.assignedTo?.uid && counts.hasOwnProperty(c.assignedTo.uid) && !c?.status?.closed){
      counts[c.assignedTo.uid]++;
    }
  });
  pool.sort((a,b)=>(counts[a.uid]||0)-(counts[b.uid]||0));
  const chosen = pool[0];
  await update(ref(db, `chats/${roomId}`), {
    assignedTo: { uid: chosen.uid, name: chosen.name, group: categoria },
    status: { queue:false, closed:false, userOnline:true, adminOnline:false, typing:{user:false,admin:false} }
  });
}

function attachRoom(nome, categoriaVal, contato){
  roomRef = ref(db, `chats/${user.roomId}`);
  msgsRef = ref(db, `chats/${user.roomId}/messages`);

  update(roomRef, {
    userLabel: user.userLabel,
    assunto:   user.assunto,
    createdAt: serverTimestamp(),
    sessionUid: auth.currentUser?.uid || null,
    status: { closed:false, queue:true, userOnline:true, adminOnline:false, typing:{user:false, admin:false} },
    userInfo: { nome, contato, categoria: categoriaVal }
  });

  // presença
  const presenceRef = ref(db, `chats/${user.roomId}/status/userOnline`);
  const lastSeenRef = ref(db, `chats/${user.roomId}/status/userLastSeen`);
  set(presenceRef, true);
  onDisconnect(presenceRef).set(false);
  onDisconnect(lastSeenRef).set(serverTimestamp());

  // tentativa de atribuição imediata
  assignAgent(user.roomId, categoriaVal).catch(console.error);

  // mensagens
  onChildAdded(msgsRef, (s)=>{
    const k=s.key, m=s.val(); const div=document.createElement('div');
    const mine = m.autorRole==='user';
    div.className = `msg ${mine?'me':'adm'}`;
    div.innerHTML = `
      ${m.autorRole==='agent' ? `<div class="small">${esc(m.autorName||'Agente')}</div>` : ''}
      ${esc(m.texto||'')}
      <span class="time">${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${m.readAt?'• Lido':''}</span>`;
    messages.appendChild(div); scroll(messages);
    if(!mine){ update(ref(db, `chats/${user.roomId}/messages/${k}`), { readAt: serverTimestamp() }); $('#ding').play().catch(()=>{}); }
  });

  // digitação
  listenTyping(user.roomId, 'admin', messages);

  msgInput.disabled=false; msgForm.querySelector('button').disabled=false;
}

$('#loginForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const nome = nomeInput.value.trim();
  const contato = contatoInput.value.trim();
  const assunto = assuntoInput.value.trim();
  const categoria = categoriaSelect.value;
  if(!nome || !contato || !assunto) return;

  try{
    await signInAnonymously(auth);
    user.roomId = `${slug(nome)}-${Date.now()}`;
    user.userLabel = nome;
    user.assunto = assunto;
    user.categoria = categoria;
    localStorage.setItem('chatUser', JSON.stringify(user));
    openChatUI(nome, categoria==='suporte'?'Suporte TI':'Status');
    attachRoom(nome, categoria, contato);
  }catch(err){
    alert('Falha ao iniciar sessão anônima. Verifique sua config do Firebase.');
    console.error(err);
  }
});

let typingTimer=null;
msgInput.addEventListener('input', ()=>{
  if(!user.roomId) return;
  setTyping(user.roomId, 'user', !!msgInput.value);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(()=>setTyping(user.roomId,'user',false), 1500);
});

msgForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const text = msgInput.value.trim(); if(!text || !msgsRef) return;
  await push(msgsRef, {
    autorUid: auth.currentUser?.uid || null,
    autorName: user.userLabel,
    autorRole: 'user',
    texto: text,
    timestamp: Date.now(),
    destinatario: "ADM"
  });
  // atualizar resumo (melhor UX na lista do ADM)
  await update(roomRef, { lastMessage: text, lastMessageAt: Date.now() });
  msgInput.value=''; setTyping(user.roomId,'user',false);
});

$('#btnLeave').addEventListener('click', async ()=>{
  chatSubtitle.textContent = 'Desconectado';
  try{ await signOut(auth); }catch(e){}
  location.reload();
});

// avaliação quando fechado
onAuthStateChanged(auth, ()=>{
  const saved = JSON.parse(localStorage.getItem('chatUser')||'null');
  if(!saved) return;
  const r = ref(db, `chats/${saved.roomId}/status/closed`);
  onValue(r, s=>{
    if(s.val()===true && !document.getElementById('ratingBox')){
      const box = document.createElement('div');
      Object.assign(box.style,{position:'fixed',inset:'0',display:'grid',placeItems:'center',background:'rgba(0,0,0,.6)',zIndex:9999});
      box.id='ratingBox';
      box.innerHTML=`
        <div class="login-card" style="max-width:420px">
          <h3>Como foi seu atendimento?</h3>
          <form id="ratingForm">
            <label>Nota (1 a 5)</label>
            <input id="ratingInput" type="number" min="1" max="5" required />
            <label>Comentário (opcional)</label>
            <input id="ratingComment" placeholder="Deixe seu feedback" />
            <button type="submit">Enviar avaliação</button>
          </form>
        </div>`;
      (chatWrap||document.body).appendChild(box);
      box.querySelector('#ratingForm').addEventListener('submit', async e=>{
        e.preventDefault();
        const nota = Number(box.querySelector('#ratingInput').value);
        const comt = box.querySelector('#ratingComment').value.trim();
        await update(ref(db, `chats/${saved.roomId}`), { rating:{ score:nota, comment:comt, at:serverTimestamp() } });
        box.remove();
      });
    }
  });
});

// logs
window.addEventListener('error', e=>console.error('[error]', e.message));
window.addEventListener('unhandledrejection', e=>console.error('[promise]', e.reason));
