import { execFileSync } from 'node:child_process';
import { workspace, type App } from '../../rodverse.config.ts';
export const allApps=Object.keys(workspace.apps) as App[];
export function affectedApps(files:string[]):App[]{
  if(files.some(f=>f==='*'||workspace.sharedPaths.test(f)))return allApps;
  return allApps.filter(app=>files.some(f=>f.startsWith(workspace.apps[app].root+'/')));
}
export function changedFiles(base:string,head:string,pr:boolean):string[]{
  const valid=(s:string)=>/^[a-f0-9]{40}$/.test(s)&&!/^0+$/.test(s);
  if(!valid(base)||!valid(head))return ['*'];
  try{return execFileSync('git',['diff','--name-only','-z',base+(pr?'...':'..')+head],{encoding:'utf8',timeout:60000}).split('\0').filter(Boolean);}
  catch{return ['*'];}
}
