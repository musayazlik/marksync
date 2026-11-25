import { describe, expect, it } from 'vitest';
import { maskEmail } from '../src/core/mask';

describe('maskEmail', () => {
  it('keeps the start, the last letter and the domain', () => {
    expect(maskEmail('musayazlik1997@gmail.com')).toBe('mu*****7@gmail.com');
    expect(maskEmail('anna@example.org')).toBe('a*****a@example.org');
    expect(maskEmail('jo@example.org')).toBe('j*****@example.org');
    expect(maskEmail('x@y.z')).toBe('x*****@y.z');
  });

  it('does not reveal how long the name is', () => {
    expect(maskEmail('abcdef@x.io').length).toBe(maskEmail('abcdefghijklmnop@x.io').length);
  });

  it('copes with odd input', () => {
    expect(maskEmail('')).toBe('');
    expect(maskEmail('notanemail')).toBe('n*****');
    expect(maskEmail('ğüşiöç@örnek.com')).toBe('ğü*****ç@örnek.com');
  });
});
