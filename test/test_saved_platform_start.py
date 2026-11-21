"""Run the production saved-session startup selector on a JVM; no devices or credentials."""
from pathlib import Path
import subprocess, tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
 'android/content/Context.java': 'package android.content; public class Context { public java.io.File getFilesDir(){return null;} }',
 'org/json/JSONArray.java': '''package org.json; public class JSONArray extends java.util.ArrayList<JSONObject>{ public int length(){return size();} public JSONObject getJSONObject(int i){return get(i);} public JSONObject optJSONObject(int i){return get(i);} }''',
 'org/json/JSONObject.java': '''package org.json; public class JSONObject extends java.util.HashMap<String,Object>{public boolean optBoolean(String k,boolean d){return containsKey(k)?(Boolean)get(k):d;} public String optString(String k){return (String)getOrDefault(k,"");} public JSONArray optJSONArray(String k){return (JSONArray)get(k);} }''',
 'com/whaleonebot/Check.java': '''package com.whaleonebot; import org.json.*;import android.content.Context;import java.util.*;
class BindingControl {static JSONArray bots(java.io.File f){throw new AssertionError();}static JSONObject find(JSONArray a,String s){throw new AssertionError();}}
class ContainerService {static void queueBoundBot(Context c,String s){throw new AssertionError();}}
class BiliProtocolControl {static List<String> seen=new ArrayList<>(),started=new ArrayList<>();static boolean owned(JSONObject r){return "bilibili".equals(r.optString("platform"));}static boolean hasSaved(Context c,String b,String k){seen.add(b+":"+k);return !k.equals("missing");}static void start(Context c,String b,String k,String p){started.add(b+":"+k);}}
public class Check {public static void main(String[] args){JSONObject bot=new JSONObject();bot.put("id","bot-a");JSONArray rows=new JSONArray();bot.put("bindings",rows);for(String id:new String[]{"off","missing","on","legacy","qq"}){JSONObject r=new JSONObject();r.put("id",id);r.put("platform",id.equals("qq")?"qq":"bilibili");if(!id.equals("legacy"))r.put("enabled",!id.equals("off"));rows.add(r);}if(!SavedBindingStartup.resume(null,bot)||!BiliProtocolControl.seen.equals(Arrays.asList("bot-a:missing","bot-a:on","bot-a:legacy"))||!BiliProtocolControl.started.equals(Arrays.asList("bot-a:on","bot-a:legacy")))throw new AssertionError();bot.put("enabled",false);if(SavedBindingStartup.resume(null,bot)||BiliProtocolControl.seen.size()!=3)throw new AssertionError();System.out.println("PASS: disabled slots untouched, missing sessions skipped, enabled and legacy resumed, disabled robot untouched");}}
'''}

def test_selector():
    with tempfile.TemporaryDirectory(dir=ROOT/'.tmp') as tmp:
        tmp=Path(tmp); files=[]
        for name,src in SOURCES.items():
            f=tmp/name; f.parent.mkdir(parents=True,exist_ok=True); f.write_text(src,encoding='utf8'); files.append(f)
        prod=ROOT/'android/app/src/com/whaleonebot/SavedBindingStartup.java'
        subprocess.run(['javac','--release','8','-Xlint:-options','-encoding','UTF-8','-d',tmp,prod,*files],check=True)
        subprocess.run(['java','-cp',tmp,'com.whaleonebot.Check'],check=True)

if __name__=='__main__': test_selector()
