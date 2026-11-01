import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readGeonames, type CityImport } from './importGeonames.js';

// Synthetic official-format rows; no fixture is presented as an official snapshot.
const source=['900','Test Town','Test Town','Tést Alias','46','23','P','PPL','RO','','13','54975','','','1234','','','Europe/Bucharest','2026-10-01'];
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function parse(options:{ fields?:Record<number,string>; admin1?:string; admin2?:string; country?:string; rows?:string[][] }={}) {
 await mkdir('work',{recursive:true});
 const dir=await mkdtemp('work/geonames-parser-');directories.push(dir);
 const fields=[...source];for(const [index,value] of Object.entries(options.fields??{}))fields[Number(index)]=value;
 const paths=['cities500.txt','countryInfo.txt','admin1CodesASCII.txt','admin2Codes.txt'].map(name=>`${dir}/${name}`);
 await Promise.all([
  writeFile(paths[0],(options.rows??[fields]).map(row=>row.join('\t')).join('\n')+'\n'),
  writeFile(paths[1],options.country??'# comment\nRO\tROU\t642\tRO\tRomania\n'),
  writeFile(paths[2],options.admin1??'RO.13\tCluj County\tCluj County\t1\n'),
  writeFile(paths[3],options.admin2??'RO.13.54975\tMunicipality\tMunicipality\t2\n'),
 ]);
 const rows:CityImport[]=[];for await(const row of readGeonames(paths[0],paths[1],paths[2],paths[3]))rows.push(row);
 return rows;
}
describe('GeoNames optional administrative labels',()=>{
 it('preserves complete source records and administrative label order',async()=>{
  expect(await parse()).toEqual([{id:'900',country:'RO',countryName:'Romania',name:'Test Town',aliases:['Test Town','Tést Alias'],
   context:'Municipality, Cluj County',admin1:'13',admin2:'54975',latitude:46,longitude:23,population:1234,modified:'2026-10-01'}]);
 });
 it.each([
  ['missing admin1',{admin1:''},'Municipality'],
  ['missing admin2',{admin2:''},'Cluj County'],
  ['missing both',{admin1:'',admin2:''},'Romania'],
  ['blank labels',{admin1:'RO.13\t   \t\t1\n',admin2:'RO.13.54975\t\t\t2\n'},'Romania'],
 ] as const)('keeps identity and codes with %s',async(_name,options,context)=>{
  const [complete]=await parse();expect(await parse(options)).toEqual([{...complete,context}]);
 });
 it.each([
  ['no codes',{10:'',11:''},'Romania'],
  ['no admin2 code',{11:''},'Cluj County'],
  ['no admin1 code',{10:''},'Romania'],
  ['unspecified admin1',{10:'00',11:''},'Romania'],
 ] as const)('retains incomplete source codes: %s',async(_name,fields,context)=>{
  const [complete]=await parse();expect(await parse({fields})).toEqual([{...complete,admin1:fields[10 as keyof typeof fields]??source[10],admin2:fields[11 as keyof typeof fields]??source[11],context}]);
 });
 it('does not resolve an admin2 label through an incomplete or another country/parent key',async()=>{
  const [row]=await parse({fields:{10:''},admin2:'RO..54975\tUnscoped\t\t1\nUS.13.54975\tOther country\t\t2\nRO.99.54975\tOther parent\t\t3\n'});
  expect(row).toMatchObject({context:'Romania',admin1:'',admin2:'54975'});
 });
 it('does not lose cities when successive rows need different fallbacks',async()=>{
  const second=[...source];second[0]='901';second[10]='99';second[11]='';
  const rows=await parse({rows:[source,second],admin2:''});
  expect(rows.map(row=>[row.id,row.context])).toEqual([['900','Cluj County'],['901','Romania']]);
 });
 it('handles the Kakavijë legacy admin2 key without assigning a modern municipality',async()=>{
  // Reconstructed regression case, not the retained bytes from Actions run #7.
  // Historical GeoNames export copy: rancheta/countryRegionCityJSON@85ebdab,
  // region_city_data/Albania/Qarku i Gjirokastrës.json (363341: AL/45/06).
  const [row]=await parse({fields:{0:'363341',1:'Kakavijë',2:'Kakavije',3:'',4:'39.90778',5:'20.35833',7:'PPLA3',8:'AL',9:'AL',10:'45',11:'06',14:'0',17:'Europe/Tirane',18:'2012-06-06'},
   country:'AL\tALB\t008\tAL\tAlbania\n',admin1:'AL.45\tGjirokastër County\tGjirokaster County\t865733\n',
   admin2:'AL.45.10944393\tBashkia Dropull\tBashkia Dropull\t10944393\n'});
  expect(row).toMatchObject({id:'363341',name:'Kakavijë',country:'AL',admin1:'45',admin2:'06',latitude:39.90778,longitude:20.35833,context:'Gjirokastër County'});
 });
 it.each([
  ['unknown country',{fields:{8:'ZZ'}},'Missing country metadata'],
  ['missing country metadata',{country:''},'Missing country metadata'],
  ['invalid country code',{fields:{8:'xx'},country:'xx\t\t\t\tCountry\n'},'Invalid GeoNames'],
  ['invalid ID',{fields:{0:'0'}},'Invalid GeoNames'],
  ['missing latitude',{fields:{4:''}},'Missing GeoNames coordinates'],
  ['blank longitude',{fields:{5:' '}},'Missing GeoNames coordinates'],
  ['non-numeric latitude',{fields:{4:'NaN'}},'Invalid GeoNames'],
  ['latitude out of range',{fields:{4:'91'}},'Invalid GeoNames'],
  ['longitude out of range',{fields:{5:'181'}},'Invalid GeoNames'],
 ] as const)('still rejects %s with missing labels',async(_name,options,message)=>{
  await expect(parse({...options,admin1:'',admin2:''})).rejects.toThrow(message);
 });
 it('still rejects malformed official rows',async()=>{
  await expect(parse({rows:[source.slice(0,18)]})).rejects.toThrow('19-column');
 });
});
