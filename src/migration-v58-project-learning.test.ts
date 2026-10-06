import { describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openStore, openStoreNoMigrate, SCHEMA_VERSION, type Database } from './store.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path:string)=>Database };

describe('v58 learning migration on disposable files only',()=>{
  test('v57 data survives, epoch fences the older reader before new DDL, restart is idempotent',()=>{
    const root=mkdtempSync(join(tmpdir(),'learning-v58-')),file=join(root,'test.db');
    try {
      let store=openStore(file); store.createTask({id:'retained',title:'Keep prior work'},new Date());
      // Exact predecessor shape for the additive migration: no learning objects.
      for(const name of ['learning_snapshot','learning_event','project_lesson','learning_policy','learning_capture']) store.handle.exec(`DROP TABLE ${name}`);
      store.handle.exec("DROP TABLE service_cursor");
      store.handle.prepare('UPDATE schema_version SET version=57').run();store.close();
      const old=new DatabaseSync(file);const oldReaderCurrent=()=>old.prepare('SELECT version FROM schema_version').get()?.['version']===57;
      expect(oldReaderCurrent()).toBe(true);expect(openStoreNoMigrate(file)).toMatchObject({ok:false,reason:'version'});
      let beforeDdl:number|undefined;
      store=openStore(file,{connect:path=>{
        const db=new DatabaseSync(path);return {prepare:sql=>db.prepare(sql),close:()=>db.close(),exec:sql=>{
          if(sql.includes('CREATE TABLE')&&beforeDdl===undefined){beforeDdl=Number(old.prepare('SELECT version FROM schema_version').get()?.['version']);expect(oldReaderCurrent()).toBe(false);}
          db.exec(sql);
        }};
      }});
      expect(beforeDdl).toBe(-57);expect(SCHEMA_VERSION).toBe(110);expect(oldReaderCurrent()).toBe(false);old.close();
      expect(store.getTask('retained')?.title).toBe('Keep prior work');expect(store.handle.prepare('PRAGMA foreign_key_check').all()).toEqual([]);store.close();
      store=openStore(file);expect(store.getTask('retained')).not.toBeNull();expect(store.handle.prepare('SELECT * FROM learning_event').all()).toEqual([]);store.close();
      const current=openStoreNoMigrate(file);expect(current.ok).toBe(true);if(current.ok)current.store.close();
    }finally{rmSync(root,{recursive:true,force:true});}
  });
  test('missing current learning authority metadata refuses instead of silently recreating it',()=>{
    const root=mkdtempSync(join(tmpdir(),'learning-missing-')),file=join(root,'test.db');
    try{const store=openStore(file);store.handle.exec('DROP TABLE learning_policy');store.close();expect(()=>openStore(file)).toThrow(/learning history is missing/);}finally{rmSync(root,{recursive:true,force:true});}
  });
});
