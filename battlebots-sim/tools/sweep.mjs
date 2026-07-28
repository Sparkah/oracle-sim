import { readFileSync } from 'node:fs';
import { backtest } from '../js/model.js';
const R=new URL('../',import.meta.url).pathname;
const {bots}=JSON.parse(readFileSync(R+'data/bots.json','utf8'));
const {fights}=JSON.parse(readFileSync(R+'data/fights.json','utf8'));
console.log('l2     k    acc    base   brier   logloss');
for (const l2 of [0.02,0.05,0.1,0.2,0.4,0.8]) {
  for (const k of [4,6,10]) {
    const bt=backtest(bots,fights,{l2,k});
    console.log(`${String(l2).padEnd(6)} ${String(k).padEnd(4)} ${(bt.accuracy*100).toFixed(1)}%  ${(bt.baseline*100).toFixed(1)}%  ${bt.brier.toFixed(4)}  ${bt.logloss.toFixed(4)}`);
  }
}
