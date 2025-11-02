// app.js v1.1
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getDatabase, ref, push, set, update, serverTimestamp, onChildAdded, onChildChanged, onValue, onDisconnect
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

const $ = s => document.querySelector(s);
const esc = s => String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const scroll = el => el && (el.scrollTop = el.scrollHeight);
const since = (ms) => { const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60); if(h>0) return `${h}h ${m%60}m`; if(m>0) return `${m}m ${s%60}s`; return `${s}s`; };

// Router simples
function route(){
  const op = location.hash.replace('#/','')==='operador';
  $('#view-user')?.classList.toggle('hidden', op);
  $('#view-op')?.classList.toggle('hidden', !op);
}
window.addEventListener('hashchange', route); route();

// ==== USER UI ====
const loginCard = $('#loginCard'), chatWrap = $('#chatWrap'), chatTitle = $('#chatTitle');
const subOnline = $('#subOnline'), subTempo=$('#subTempo'), roomIdSpan=$('#roomIdSpan');
const nomeInput=$('#nomeInput'), contatoInput=$('#contatoInput'), assuntoInput=$('#assuntoInput'), categoriaSelect=$('#categoriaSelect');
const msgForm = $('#msgForm'), msgInput = $('#msgInput'), messages = $('#messages'), btnLeave=$('#btnLeave'), ding=$('#ding');
const btnAlert=$('#btnAlert'); const userOverlay=$('#userOverlay');

let roomId=null, msgsRef=null, roomRef=null, me={}, waitTimer=null;

// debug visual
function showBanner(text, kind='info'){
  let b=document.getElementById('banner'); if(!b){ b=document.createElement('div'); b.id='banner';
    Object.assign(b.style,{position:'fixed',left:'10px',bottom:'10px',padding:'8px 10px',background:'#111a',color:'#eee',border:'1px solid #333',borderRadius:'6px',font:'12px monospace',zIndex:9999});
    document.body.appendChild(b);
  }
  b.style.color = kind==='error' ? '#ff9aa2' : '#eee';
  b.textContent = text;
}

function openChatUI(nome, catLabel){
  loginCard.classList.add('hidden'); chatWrap.classList.remove('hidden');
  chatTitle.textContent = `${nome} • ${catLabel}`;
}

function attachPresence(){
  const pRef = ref(db, `chats/${roomId}/status/userOnline`);
  const lastRef = ref(db, `chats/${roomId}/status/userLastSeen`);
  set(pRef, true); onDisconnect(pRef).set(false); onDisconnect(lastRef).set(serverTimestamp());
}

function attachTyping(){
  onValue(ref(db, `chats/${roomId}/status/typing/admin`), s=>{
    const v = !!s.val();
    const tip = $('#typingHint');
    tip.textContent = v ? 'Operador está digitando…' : '';
  });

  msgInput.addEventListener('input', ()=>{
    if(!roomId) return;
    set(ref(db, `chats/${roomId}/status/typing/user`), !!msgInput.value);
  });
}

function attachClosed(){
  onValue(ref(db, `chats/${roomId}/status/closed`), s=>{
    const closed = !!s.val();
    userOverlay.style.display = closed ? 'flex' : 'none';
    msgInput.disabled = closed;
    msgForm.querySelector('button').disabled = closed;
  });
}

function attachWait(){
  onValue(ref(db, `chats/${roomId}/lastMessageAt`), s=>{
    const t = s.val();
    if(!t){ subTempo.textContent='—'; return; }
    const upd = ()=> subTempo.textContent = `última atividade há ${since(Date.now()-t)}`;
    upd(); clearInterval(waitTimer); waitTimer=setInterval(upd, 1000);
  });
}

function attachMessages(){
  msgsRef = ref(db, `chats/${roomId}/messages`);
  onChildAdded(msgsRef, (snap)=>{
    const k = snap.key, m = snap.val();
    const mine = m.autorRole==='user';
    const d = document.createElement('div');
    d.id = `msg-${k}`;
    d.className = `msg ${mine?'me':'op'}`;
    const ticks = mine ? `<span class="tick ${m.readAt?'seen':''}">${m.readAt?'✓✓':'✓✓'}</span>` : '';
    d.innerHTML = `${esc(m.texto||'')}<div class="meta">${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${ticks}</div>`;
    messages.appendChild(d); scroll(messages);
    if(!mine){ update(ref(db, `chats/${roomId}/messages/${k}`), { readAt: serverTimestamp() }); ding?.play().catch(()=>{}); }
  });

  onChildChanged(msgsRef, (snap)=>{
    const k=snap.key, m=snap.val();
    const el=document.getElementById(`msg-${k}`); if(!el) return;
    const mine = m.autorRole==='user';
    if(mine){
      const meta = el.querySelector('.meta');
      const ticks = `<span class="tick ${m.readAt?'seen':''}">${m.readAt?'✓✓':'✓✓'}</span>`;
      if(meta) meta.innerHTML = `${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${ticks}`;
    }
  });
}

function attachSignals(uid){
  // operador envia /signals/{uid} { reset:true }
  onValue(ref(db, `signals/${uid}`), async s=>{
    const v = s.val();
    if(v && v.reset){
      alert('Atendimento finalizado. Vamos reiniciar seu questionário.');
      try{
        // limpa o sinal
        await set(ref(db, `signals/${uid}`), null);
      }catch(_){}
      try{ await signOut(auth);}catch(_){}
      location.reload();
    }
  });
}

$('#loginForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const nome = nomeInput.value.trim(), contato = contatoInput.value.trim(), assunto = assuntoInput.value.trim(), categoria=categoriaSelect.value;
  if(!nome||!contato||!assunto) return;

  try{
    await signInAnonymously(auth);
    const uid = await new Promise((res,rej)=>{
      const off = onAuthStateChanged(auth, u=>{ if(u){ off(); res(u.uid); }}, rej);
    });
    showBanner(`auth uid=${uid}`);

    roomId = `${nome.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${Date.now()}`;
    roomRef = ref(db, `chats/${roomId}`);
    me = { nome, contato, assunto, categoria };

    await set(roomRef, {
      userLabel: nome,
      assunto,
      createdAt: serverTimestamp(),
      sessionUid: uid,
      status:{ queue:true, closed:false, userOnline:true, adminOnline:false, typing:{user:false,admin:false}},
      userInfo:{ nome, contato, categoria },
      lastMessage: "", lastMessageAt: serverTimestamp(), lastMessageRole: "",
      alerts: { count:0, lastAt:0 }
    });

    openChatUI(nome, categoria==='suporte'?'Suporte TI':'Operação');
    roomIdSpan.textContent = `Chat: ${roomId}`;
    attachPresence(); attachTyping(); attachWait(); attachMessages(); attachClosed(); attachSignals(uid);
    msgInput.disabled=false; msgForm.querySelector('button').disabled=false;
  }catch(err){
    console.error('Falha ao criar chat', err);
    showBanner(`Erro criando chat: ${err?.code||err?.message||err}`, 'error');
  }
});

// ALERTA (até 3x por 30 min)
btnAlert.addEventListener('click', async ()=>{
  if(!roomRef) return;
  const now = Date.now();
  const THIRTY = 30*60*1000;

  const snap = await new Promise(res=> onValue(ref(db, `chats/${roomId}/alerts`), s=>{ res(s); }, { onlyOnce:true }));
  const a = snap.val() || { count:0, lastAt:0 };
  if(a.count >= 3 && (now - a.lastAt) < THIRTY){
    alert('Você atingiu o limite de alertas. Tente mais tarde.');
    return;
  }
  const newCount = (now - a.lastAt) >= THIRTY ? 1 : (a.count+1);
  await update(ref(db, `chats/${roomId}/alerts`), { count:newCount, lastAt: now });
  await push(ref(db, `chats/${roomId}/alerts/events`), { at: now });

  alert('Alerta enviado ao operador!');
});

msgForm.addEventListener('submit', async (e)=>{
  e.preventDefault(); if(!msgsRef) return;
  const texto = msgInput.value.trim(); if(!texto) return;
  const now = Date.now();
  await push(msgsRef, {
    autorUid: auth.currentUser?.uid||null, autorName: me.nome, autorRole:'user',
    texto, timestamp: now, destinatario: 'Operador'
  });
  await update(roomRef, { lastMessage: texto, lastMessageAt: now, lastMessageRole:'user', lastUserMsgAt: now });
  msgInput.value=''; set(ref(db, `chats/${roomId}/status/typing/user`), false);
});

btnLeave.addEventListener('click', async ()=>{
  if(roomId){
    const now = Date.now();
    await update(ref(db, `chats/${roomId}`), { lastMessage: 'Usuário desconectou.', lastMessageRole: 'system', lastMessageAt: now });
    await push(ref(db, `chats/${roomId}/messages`), { autorRole:'system', autorName:'Sistema', texto:'Usuário desconectou.', timestamp: now });
    await update(ref(db, `chats/${roomId}/status`), { userOnline:false, disconnectedAt: now });
  }
  try{ await signOut(auth);}catch(_){}
  location.reload();
});
