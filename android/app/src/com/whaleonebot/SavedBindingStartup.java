package com.whaleonebot;
import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
/** Cold startup and explicit start both resume only existing, user-approved accounts. */
final class SavedBindingStartup {
 static boolean resume(Context c,JSONObject bot){boolean any=false; if(!bot.optBoolean("enabled",true))return false;JSONArray rows=bot.optJSONArray("bindings"); if(rows==null)return false;String id=bot.optString("id");
  for(int i=0;i<rows.length();i++){JSONObject row=rows.optJSONObject(i);if(row==null||!row.optBoolean("enabled",true)||!BiliProtocolControl.owned(row))continue;String binding=row.optString("id");if(BiliProtocolControl.hasSaved(c,id,binding)){BiliProtocolControl.start(c,id,binding,row.optString("peerId"));any=true;}}
  return any;
 }
 static void onReady(Context c){try{JSONArray bots=BindingControl.bots(c.getFilesDir());for(int i=0;i<bots.length();i++)try{JSONObject b=bots.getJSONObject(i);if(resume(c,b)&&"builtin".equals(b.optString("runtimeKind")))ContainerService.queueBoundBot(c,b.optString("id"));}catch(Exception ignored){}}catch(Exception ignored){}}
 static void onStart(Context c,String id){try{resume(c,BindingControl.find(BindingControl.bots(c.getFilesDir()),id));}catch(Exception ignored){}}
}
