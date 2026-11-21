// JVM check of the production Android class. Stub only the subprocess/Android service boundary.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const sdk=process.env.ANDROID_HOME||process.env.ANDROID_SDK_ROOT||(process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Android','Sdk'):'');const jar=path.join(sdk,'platforms','android-36','android.jar');
test('verified attachment waits for every binding, consumes one request, ignores stale intents and stops', {skip:fs.existsSync(jar)?false:'Android 36 SDK needed for host JVM test'}, t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'whale-verify-attach-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const fixture=`package com.whaleonebot;import java.util.*;import java.io.*;import android.content.Context;import org.json.*;
 class ContainerService{File getFilesDir(){throw new AssertionError();}static boolean isRunning(){throw new AssertionError();}static ProcessBuilder containerBuilder(File f,String c){throw new AssertionError();}}
 class BiliProtocolControl{static boolean owned(JSONObject r){throw new AssertionError();}static String lease(String b,JSONObject r,JSONObject copy){throw new AssertionError();}}
 public class Check{static void ok(boolean b){if(!b)throw new AssertionError();} public static void main(String[]args){Set<String> all=new HashSet<>(Arrays.asList("a","b"));BindingControl.VerifiedAttachBarrier gate=new BindingControl.VerifiedAttachBarrier("rev",all);
 ok(!gate.accept("rev","a",Collections.singleton("a")));ok(!gate.accept("other","b",all));ok(!gate.accept("rev","unrelated",all));ok(gate.accept("rev","b",all));ok(!gate.accept("rev","b",all));
 String old=BindingControl.queue("robot");ok(old!=null&&BindingControl.queue("robot")==null);BindingControl.stop("robot");ok(BindingControl.verifiedTicket(null,"robot","a")==null);
 String current=BindingControl.queue("robot");ok(current!=null&&!current.equals(old));BindingControl.launch(null,"robot",old);ok(BindingControl.queue("robot")==null);BindingControl.stopAll();BindingControl.launch(null,"robot",current);ok(BindingControl.verifiedTicket(null,"robot","a")==null);
 }} `;
 const check=path.join(base,'Check.java');fs.writeFileSync(check,fixture);
 for(const [bin,args] of [['javac',['--release','8','-encoding','UTF-8','-cp',jar,'-d',base,'android/app/src/com/whaleonebot/BindingControl.java',check]],['java',['-cp',base+path.delimiter+jar,'com.whaleonebot.Check']]]){const result=spawnSync(bin,args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr||String(result.error));}
});
