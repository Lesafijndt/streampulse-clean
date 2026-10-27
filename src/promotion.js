export function isActivePromotion(video) { return video?.promotion?.state === 'active' && Number(video.promotion.requestTimestamp) === Number(video.timestamp || 0); }
export const PROMOTION_RATE = 50;
export function promotionLabel(video) {
  const p = video?.promotion;
  if (!p || !Number.isSafeInteger(p.points) || p.points <= 0) return '';
  const amount = p.points.toLocaleString('en-US');
  if (p.state === 'active' && video.status === 'queue' && !isActivePromotion(video)) return 'Previously promoted \u00b7 ' + amount + ' points spent' + (p.paidBy ? ' by @'+p.paidBy : '');
  if (p.state === 'active') return 'Promoted \u00b7 ' + amount + ' points spent' + (p.paidBy ? ' by @'+p.paidBy : '');
  if (p.state === 'refunding') return 'Promotion cancelled \u00b7 ' + amount + ' points refund pending';
  if (p.state === 'refunded') return 'Promotion cancelled \u00b7 ' + amount + ' points refunded';
  return '';
}
