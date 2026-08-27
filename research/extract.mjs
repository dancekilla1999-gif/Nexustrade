// Вытаскивает из index.html настоящий код индикаторов и генератора сигналов.
// Переписывать правила заново нельзя: расхождение бэктеста и приложения —
// это ровно та ошибка, из-за которой бэктест перестаёт что-либо значить.
import fs from 'fs';
const src = fs.readFileSync('/home/user/nexustrade/index.html','utf8');

function grab(name){
  const i = src.indexOf('function '+name+'(');
  if(i<0) throw new Error('не найдена функция '+name);
  let d=0, started=false;
  for(let j=i;j<src.length;j++){
    const ch=src[j];
    if(ch==='{'){ d++; started=true; }
    else if(ch==='}'){ d--; if(started&&d===0) return src.slice(i,j+1); }
  }
  throw new Error('не закрыта '+name);
}
// Зависимости разрешаем автоматически: берём нужные функции, смотрим, каких
// ещё не хватает, и добираем — пока замыкание не станет полным.
const WANT=['computeSignal','structLevels','nearestAbove','nearestBelow'];
const ALL=[...src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m=>m[1]);
const picked=new Set(WANT);
for(let pass=0; pass<12; pass++){
  const body=[...picked].map(f=>{try{return grab(f)}catch(e){return ''}}).join('\n');
  let added=false;
  for(const name of ALL){
    if(picked.has(name)) continue;
    if(new RegExp('\\b'+name+'\\s*\\(').test(body)){ picked.add(name); added=true; }
  }
  if(!added) break;
}
const FNS=[...picked];
const consts = ['SIG_MIN_MOVE','SIG_MIN_RR','SIG_MIN_PASS']
  .map(c=>{ const m=src.match(new RegExp('const\\s+'+c+'\\s*=\\s*([0-9.]+)')); return `const ${c}=${m[1]};`; })
  .join('\n');

let out = '// СГЕНЕРИРОВАНО: код извлечён из index.html, не редактировать\n'+consts+'\n';
out += 'function decOf(){return 2;}\n';
// computeSignal читает свечи через realKlines — подменяем на прямой доступ
out += 'let __K=null;\nfunction realKlines(){ return __K; }\n';
for(const f of FNS){
  if(f==='realKlines'||f==='decOf') continue;   // эти подменены выше
  out += grab(f)+'\n';
}
out += 'export function signalOn(bars){ __K=bars; return computeSignal("X"); }\n';
fs.writeFileSync('/tmp/bt/engine.mjs', out);
console.log('извлечено функций:', FNS.length, '| размер', (out.length/1024).toFixed(1)+' КБ');
console.log('константы:', consts.replace(/\n/g,' '));
