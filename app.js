// app.js v2.3
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getDatabase, ref, push, set, update, serverTimestamp,
  onChildAdded, onChildChanged, onValue, onDisconnect, remove
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { getAuth, signInAnonymously, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const db  = getDatabase(app);
export const auth= getAuth(app);

const $ = s => document.querySelector(s);
const esc = s => String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const scroll = el => el && (el.scrollTop = el.scrollHeight);
const since = (ms)=>{const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60);if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`;};

const notifyEl = document.getElementById('notify');
const playNotify = ()=>{ try{ if(notifyEl){ notifyEl.currentTime=0; notifyEl.play().catch(()=>{});} }catch(_){ } };

function route(){
  const hash = location.hash.replace('#/','');
  const op = hash==='operador', saved = hash==='salvos';
  $('#view-user')?.classList.toggle('hidden', op||saved);
  $('#view-op')?.classList.toggle('hidden', !op);
  $('#view-saved')?.classList.toggle('hidden', !saved);
}
addEventListener('hashchange', route); route();

// UI refs
const loginCard=$('#loginCard'), chatWrap=$('#chatWrap'), chatTitle=$('#chatTitle');
const subOnline=$('#subOnline'), subTempo=$('#subTempo'), roomIdSpan=$('#roomIdSpan');
const nomeInput=$('#nomeInput'), contatoInput=$('#contatoInput'), assuntoInput=$('#assuntoInput'), categoriaSelect=$('#categoriaSelect'), tmpCheck=$('#tmpCheck');
const msgForm=$('#msgForm'), msgInput=$('#msgInput'), messages=$('#messages'), btnLeave=$('#btnLeave'), btnAlert=$('#btnAlert'), userOverlay=$('#userOverlay');

let roomId=null, msgsRef=null, roomRef=null, me={}, waitTimer=null, tempMode=false, idleTimer=null;

function openChatUI(nome, cat){ loginCard.classList.add('hidden'); chatWrap.classList.remove('hidden'); chatTitle.textContent = `${nome} • ${cat}`; }
function attachPresence(){
  const p=ref(db,`chats/${roomId}/status/userOnline`), last=ref(db,`chats/${roomId}/status/userLastSeen`);
  set(p,true); onDisconnect(p).set(false); onDisconnect(last).set(serverTimestamp());
}
function attachTyping(){
  onValue(ref(db,`chats/${roomId}/status/typing/admin`), s=>{ $('#typingHint').textContent = s.val() ? 'Operador está digitando…' : ''; });
  msgInput.addEventListener('input', ()=>{ if(!roomId) return; set(ref(db,`chats/${roomId}/status/typing/user`), !!msgInput.value); bumpActivity(); });
}
function attachOperatorOnline(){
  onValue(ref(db,`chats/${roomId}/status/adminOnline`), s=>{
    const on=!!s.val(); subOnline.classList.toggle('online',on); subOnline.classList.toggle('offline',!on); subOnline.innerHTML=`<span class="dot"></span> ${on?'online':'offline'}`;
  });
}
function attachClosed(){
  onValue(ref(db,`chats/${roomId}/status/closed`), s=>{
    const closed=!!s.val(); userOverlay.style.display = closed?'flex':'none'; msgInput.disabled=closed; msgForm.querySelector('button').disabled=closed;
  });
}
function attachWait(){
  onValue(ref(db,`chats/${roomId}/lastMessageAt`), s=>{
    const t=s.val(); if(!t){ subTempo.textContent='—'; return; }
    const upd=()=> subTempo.textContent = `última atividade há ${since(Date.now()-t)}`; upd(); clearInterval(waitTimer); waitTimer=setInterval(upd,1000);
  });
}
function attachMessages(){
  msgsRef = ref(db,`chats/${roomId}/messages`);
  onChildAdded(msgsRef, snap=>{
    const k=snap.key, m=snap.val(); const mine=m.autorRole==='user';
    const d=document.createElement('div'); d.id=`msg-${k}`; d.className=`msg ${mine?'me':'op'}`;
    const ticks = mine ? `<span class="tick ${m.readAt?'seen':''}">${m.readAt?'✓✓':'✓✓'}</span>` : '';
    d.innerHTML=`${esc(m.texto||'')}<div class="meta">${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${ticks}</div>`;
    messages.appendChild(d); scroll(messages);
    if(!mine){ update(ref(db,`chats/${roomId}/messages/${k}`),{readAt:serverTimestamp()}); playNotify(); }
  });
  onChildChanged(msgsRef, snap=>{
    const k=snap.key, m=snap.val(); const el=document.getElementById(`msg-${k}`); if(!el) return;
    if(m.autorRole==='user'){ const meta=el.querySelector('.meta'); const ticks=`<span class="tick ${m.readAt?'seen':''}">${m.readAt?'✓✓':'✓✓'}</span>`; if(meta) meta.innerHTML=`${new Date(m.timestamp||Date.now()).toLocaleTimeString()} ${ticks}`; }
  });
}

function bumpActivity(){
  if(!roomId) return;
  const now=Date.now(); update(ref(db,`chats/${roomId}`),{ lastUserMsgAt: now });
  if(tempMode){
    clearTimeout(idleTimer);
    idleTimer=setTimeout(async ()=>{
      const base=`chats/${roomId}`;
      const s=await new Promise(res=> onValue(ref(db,base+'/mode'),v=>res(v),{onlyOnce:true}));
      if(s && s.val()==='temp'){ await remove(ref(db,base)); await set(ref(db,`purged/${roomId}`),true); }
      try{ await signOut(auth);}catch(_){}
      location.reload();
    }, 600000);
  }
}
function attachSignals(uid){
  onValue(ref(db,`signals/${uid}`), async s=>{
    const v=s.val(); if(v && v.reset){ alert('Atendimento finalizado. Vamos reiniciar seu questionário.'); try{ await set(ref(db,`signals/${uid}`),null);}catch(_){} try{ await signOut(auth);}catch(_){ } location.reload(); }
  });
}

// criar sala
$('#loginForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const nome=nomeInput.value.trim(), contato=contatoInput.value.trim(), assunto=assuntoInput.value.trim(), categoria=categoriaSelect.value;
  if(!nome||!contato||!assunto) return;
  try{
    await signInAnonymously(auth);
    const uid = await new Promise((res,rej)=>{ const off=onAuthStateChanged(auth,u=>{ if(u){ off(); res(u.uid); }},rej); });
    roomId = `${nome.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${Date.now()}`;
    const roomPath=`chats/${roomId}`; roomRef=ref(db,roomPath); me={nome,contato,assunto,categoria}; tempMode=!!tmpCheck.checked;

    await set(roomRef,{
      userLabel:nome, assunto, createdAt: serverTimestamp(), sessionUid: uid,
      status:{
        queue:true, closed:false, userOnline:true, adminOnline:false,
        typing:{user:false,admin:false},
        newForOp:true   // <<< marca "novo" para o operador
      },
      userInfo:{ nome, contato, categoria },
      lastMessage:"", lastMessageAt: serverTimestamp(), lastMessageRole:"",
      alerts:{ count:0, lastAt:0 }, mode: tempMode ? 'temp' : 'normal',
      lastUserMsgAt: Date.now()
    });

    openChatUI(nome, categoria==='suporte'?'Suporte TI':'Operação');
    roomIdSpan.textContent=`Chat: ${roomId}`;
    attachPresence(); attachTyping(); attachOperatorOnline(); attachWait(); attachMessages(); attachClosed(); attachSignals(uid);
    msgInput.disabled=false; msgForm.querySelector('button').disabled=false; bumpActivity();
  }catch(err){ console.error('Falha ao criar chat',err); alert('Erro ao criar chat.'); }
});

// alerta
btnAlert.addEventListener('click', async ()=>{
  if(!roomRef) return;
  const now=Date.now(), THIRTY=30*60*1000;
  const snap=await new Promise(res=> onValue(ref(db,`chats/${roomId}/alerts`),s=>res(s),{onlyOnce:true}));
  const a=snap.val()||{count:0,lastAt:0};
  if(a.count>=3 && (now-a.lastAt)<THIRTY){ alert('Você atingiu o limite de alertas.'); return; }
  const newCount = (now-a.lastAt)>=THIRTY ? 1 : (a.count+1);
  await update(ref(db,`chats/${roomId}/alerts`),{count:newCount,lastAt:now});
  await push(ref(db,`chats/${roomId}/alerts/events`),{at:now});
  playNotify();
  alert('Alerta enviado ao operador!');
});

// enviar mensagem do usuário
msgForm.addEventListener('submit', async (e)=>{
  e.preventDefault(); if(!msgsRef) return;
  const texto=msgInput.value.trim(); if(!texto) return;
  const now=Date.now();
  await push(msgsRef,{ autorUid: auth.currentUser?.uid||null, autorName: me.nome, autorRole:'user', texto, timestamp: now, destinatario:'Operador' });
  await update(roomRef,{ lastMessage:texto, lastMessageAt: now, lastMessageRole:'user', lastUserMsgAt: now });
  // marca novamente como "novo" para o operador (caso ele não esteja com a sala aberta)
  await update(ref(db,`chats/${roomId}/status`),{ newForOp: true });
  msgInput.value=''; set(ref(db,`chats/${roomId}/status/typing/user`), false);
  bumpActivity();
});

// sair
btnLeave.addEventListener('click', async ()=>{
  if(roomId){
    const now=Date.now();
    await update(ref(db,`chats/${roomId}`),{ lastMessage:'Usuário desconectou.', lastMessageRole:'system', lastMessageAt: now });
    await push(ref(db,`chats/${roomId}/messages`),{ autorRole:'system', autorName:'Sistema', texto:'Usuário desconectou.', timestamp: now });
    await update(ref(db,`chats/${roomId}/status`),{ userOnline:false, disconnectedAt: now });
  }
  try{ await signOut(auth);}catch(_){}
  location.reload();
});
