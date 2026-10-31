export const normalizeCityName = (name: string) => name.normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/ß/g, 'ss').replace(/ł/g, 'l').replace(/æ/g, 'ae').replace(/ø/g, 'o').trim();
