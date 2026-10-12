export type Tier = 'standard'|'premium'|'test';
export const CLIENT_MARKUP_RATE = 0.30;

function assertPositive(value:number,label:string):void {
  if(!Number.isFinite(value)||value<=0) throw new Error(`${label} doit être un nombre positif`);
}
function assertNonNegative(value:number,label:string):void {
  if(!Number.isFinite(value)||value<0) throw new Error(`${label} doit être un nombre positif ou nul`);
}

export function estimatePriceFcfa(seconds:number,tier:Tier):number {
  assertPositive(seconds,'La durée');
  const pricePerSecond=tier==='standard'?460:700;
  return Math.round(seconds*pricePerSecond);
}

export function estimateRealCost(seconds:number,usdPerSecond:number,usdToEur:number,eurToFcfa:number){
  assertPositive(seconds,'La durée');
  assertNonNegative(usdPerSecond,'Le tarif fournisseur');
  assertPositive(usdToEur,'Le taux USD/EUR');
  assertPositive(eurToFcfa,'Le taux EUR/FCFA');
  const costUsd=seconds*usdPerSecond;
  const costEur=costUsd*usdToEur;
  return {costUsd,costEur,costRealFcfa:costEur*eurToFcfa};
}

/** Client billing is the Fal usage charge converted to FCFA, plus a 30% markup. */
export function calculateClientPriceFcfa(costUsd:number,usdToEur:number,eurToFcfa:number):number {
  assertNonNegative(costUsd,'Le coût fournisseur');
  assertPositive(usdToEur,'Le taux USD/EUR');
  assertPositive(eurToFcfa,'Le taux EUR/FCFA');
  return Math.ceil(costUsd*usdToEur*eurToFcfa*(1+CLIENT_MARKUP_RATE));
}

export function formatFcfa(amount:number):string {
  assertNonNegative(amount,'Le montant');
  const formatted=new Intl.NumberFormat('fr-FR',{maximumFractionDigits:0}).format(Math.round(amount));
  return `${formatted.replace(/[\u00a0\u202f ]/g,'\u00a0')} FCFA`;
}
