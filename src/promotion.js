export function isActivePromotion(video) { return Number.isSafeInteger(video?.promotion?.points) && video.promotion.points>0 && video.promotion.state === 'active' && Number(video.promotion.requestTimestamp) === Number(video.timestamp || 0); }
export const PROMOTION_RATE = 50;
export function promotionLabel(video) {
  const p = video?.promotion;
  if (p?.version === 2) {
    const format = value => Math.max(0,Number(value)||0).toLocaleString('en-US');
    const details=[];
    if(p.points>0) details.push((isActivePromotion(video) || video.status!=='queue' ? 'Promoted' : 'Previously promoted')+' · '+format(p.points)+' points spent · '+p.contributorCount+' contributor'+(p.contributorCount===1?'':'s')+(p.paidBy ? ' (@'+p.paidBy+')' : ''));
    if(p.refundPending>0)details.push(format(p.refundPending)+' points refund pending');
    if(p.refundedPoints>0)details.push(format(p.refundedPoints)+' points refunded');
    return details.join(' · ');
  }
  if (!p || !Number.isSafeInteger(p.points) || p.points <= 0) return '';
  const amount = p.points.toLocaleString('en-US');
  if (p.state === 'active' && video.status === 'queue' && !isActivePromotion(video)) return 'Previously promoted \u00b7 ' + amount + ' points spent' + (p.paidBy ? ' by @'+p.paidBy : '');
  if (p.state === 'active') return 'Promoted \u00b7 ' + amount + ' points spent' + (p.paidBy ? ' by @'+p.paidBy : '');
  if (p.state === 'refunding') return 'Promotion cancelled \u00b7 ' + amount + ' points refund pending';
  if (p.state === 'refunded') return 'Promotion cancelled \u00b7 ' + amount + ' points refunded';
  return '';
}
