import { CATEGORY_META, isTwitchClipUrl } from '../src/mediaUtils.js';
import { rememberCategory, mediaKey } from '../src/categoryMemory.js';
import { getPlaybackGeneration } from '../src/playerBridge.js';

const fail = (code, status = 400) => Object.assign(new Error(code), {code,status});
export async function learnQueueCategory(db, prefix, identity, body) {
  if (typeof body.category !== 'string' || !Object.hasOwn(CATEGORY_META,body.category)) throw fail('invalid_category');
  return db.runTransaction(async tx => {
    const ref = db.doc(prefix+'queue_videos/'+body.id), settings = db.doc(prefix+'room_settings/2o3a');
    const [snapshot, config] = await Promise.all([tx.get(ref),tx.get(settings)]);
    const row = snapshot.data();
    if (!row || row.channelRoom !== '2o3a' || getPlaybackGeneration(row) !== body.generation) throw fail('conflict',409);
    if (body.category === 'Clips' && !isTwitchClipUrl(row.url)) throw fail('invalid_category');
    const rules = rememberCategory(config.data()?.categoryCorrections, row, body.category);
    tx.update(ref,{category:body.category,categoryManuallySet:true,mediaType:body.category==='Music'?'Music':'Non-Music'});
    tx.set(settings,{channelRoom:'2o3a',categoryCorrections:rules},{merge:true});
    return rules;
  });
}

export async function savePlaybackReport(db, prefix, identity, body) {
  if (identity.login !== 'paim_beach_pete') throw fail('moderator_required',403);
  return db.runTransaction(async tx => {
    const ref = db.doc(prefix+'system_diagnostics/playback-reports');
    const [snapshot, video] = await Promise.all([tx.get(ref),tx.get(db.doc(prefix+'queue_videos/'+body.id))]);
    const row = video.data();
    if (!row || row.channelRoom !== '2o3a' || row.status !== 'playing' || getPlaybackGeneration(row) !== body.generation) throw fail('conflict',409);
    const now=Date.now(), reports=snapshot.data()?.reports || [];
    if (reports.some(report=>report.generation===body.generation && report.at>now-60000)) throw fail('report_recently_saved',409);
    const finite=(value,max)=>Number.isFinite(Number(value))?Math.max(0,Math.min(max,Number(value))):null;
    const report={at:now,id:String(row.id || body.id),generation:body.generation,platform:String(row.platform || '').slice(0,30),
      title:String(row.title || '').slice(0,400),mediaKey:mediaKey(row.url),
      issue:['start','stutter','controls','completion','audio','black_screen','other'].includes(body.issue)?body.issue:'other',
      providerCode:/^[a-z0-9_:-]{1,50}$/i.test(String(body.providerCode || ''))?String(body.providerCode):'',
      seconds:finite(body.seconds,86400),volume:finite(body.volume,100),paused:body.paused===true,muted:body.muted===true};
    tx.set(ref,{reports:[report,...reports].slice(0,100)});
    return report;
  });
}
