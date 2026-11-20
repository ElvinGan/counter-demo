function number(value) { return String(Math.round(value * 100) / 100); }

export function reading({ passed, stopped, bought, bestStopRate, bestBuyRate, billsNeeded }) {
  if (![passed, stopped, bought, bestStopRate, bestBuyRate, billsNeeded].every(n => Number.isFinite(n) && n >= 0)) {
    throw new RangeError('Counts, rates, and bills needed must be finite and nonnegative');
  }
  const stopRate = passed > 0 ? stopped / passed : 0;
  const buyRate = stopped > 0 ? bought / stopped : 0;
  const bestCase = passed * bestStopRate * bestBuyRate;
  let verdict;
  // Meeting the bills target takes precedence over either diagnostic comparison.
  if (bought >= billsNeeded) verdict = 'none';
  else if (bestCase < billsNeeded) verdict = 'location';
  else {
    const stopShare = bestStopRate > 0 ? stopRate / bestStopRate : 1;
    const buyShare = bestBuyRate > 0 ? buyRate / bestBuyRate : 1;
    verdict = stopShare <= buyShare ? 'staff' : 'offer';
  }
  const lines = [
    `${number(passed)} people passed and ${number(stopped)} stopped: ${number(stopRate * 100)}%, compared with your best ${number(bestStopRate * 100)}%.`,
    `${number(bought)} bills from ${number(stopped)} stops: ${number(buyRate * 100)}%, compared with your best ${number(bestBuyRate * 100)}%.`,
  ];
  if (verdict === 'none') lines.push(`${number(bought)} bills meets the ${number(billsNeeded)} bills needed.`);
  else if (verdict === 'location') lines.push(`Even at your best rates, ${number(passed)} passers-by would bring ${number(bestCase)} bills, below the ${number(billsNeeded)} needed to cover rent.`);
  else if (verdict === 'staff') lines.push(`Your best rates could bring ${number(bestCase)} bills against ${number(billsNeeded)} needed; getting people to stop is further below your best, so check the staff or display at the front.`);
  else lines.push(`Your best rates could bring ${number(bestCase)} bills against ${number(billsNeeded)} needed; getting people to buy is further below your best, so check the offer or price.`);
  return { verdict, stopRate, buyRate, bestCase, lines };
}
