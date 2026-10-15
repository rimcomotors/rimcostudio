import { describe, expect, it } from 'vitest';
import { estimatePriceFcfa, estimateRealCost, formatFcfa } from './pricing';

describe('pricing',()=>{
  it('applies the fixed five-second client price by tier',()=>{
    expect(estimatePriceFcfa(5,'standard')).toBe(2300);
    expect(estimatePriceFcfa(5,'pro')).toBe(3500);
    expect(estimatePriceFcfa(5,'premium')).toBe(3500);
    expect(estimatePriceFcfa(5,'test')).toBe(3500);
  });
  it('converts real provider cost to EUR and FCFA',()=>{
    expect(estimateRealCost(5,.1,.9,655.957)).toEqual({costUsd:.5,costEur:.45,costRealFcfa:.45*655.957});
  });
  it('formats FCFA without decimals and with a non-breaking thousands separator',()=>{
    expect(formatFcfa(1234567)).toBe('1\u00a0234\u00a0567 FCFA');
    expect(formatFcfa(3500)).toBe('3\u00a0500 FCFA');
  });
  it('rejects invalid inputs at the pricing boundary',()=>{
    expect(()=>estimatePriceFcfa(0,'standard')).toThrow();
    expect(()=>estimateRealCost(5,-.1,.9,655.957)).toThrow();
  });
});
