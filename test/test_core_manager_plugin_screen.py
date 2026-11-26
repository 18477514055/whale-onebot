"""Headless JVM regression: click the production plugin page twice without navigating away.

Only the views, dialog, registry and installer are doubles. The page, its background work,
confirmation, completion callback, filesystem receipt read and displayed text are real.
"""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCREEN = ROOT/'android/app/src/com/whaleonebot/ui/CoreManagerScreen.java'

# Small host API used by this screen. Only widget text, children, clicks and UI scheduling matter.
STUBS = {
 'android/R': 'public class R { public static class attr { public static int progressBarStyleHorizontal; } }',
 'android/content/Context': 'public class Context { public static final int MODE_PRIVATE = 0; }',
 'android/content/SharedPreferences': '''public interface SharedPreferences {
   long getLong(String k, long d);
   Editor edit();
   interface Editor { Editor putLong(String k, long v); void apply(); }
 }''',
 'android/app/Activity': '''public class Activity extends android.content.Context {
   public java.io.File files;
   public java.util.concurrent.BlockingQueue<Runnable> queue=new java.util.concurrent.LinkedBlockingQueue<>();
   public void runOnUiThread(Runnable r){queue.add(r);}
   public java.io.File getFilesDir(){return files;}
   public android.content.pm.PackageManager pm=new android.content.pm.PackageManager();
   public android.content.pm.PackageManager getPackageManager(){return pm;}
   public android.content.Intent launched;
   public void startActivityForResult(android.content.Intent i,int n){launched=i;}
   public java.util.Map<String,Long> prefs=new java.util.HashMap<>();
   public android.content.SharedPreferences getSharedPreferences(String n,int m){
     return new android.content.SharedPreferences(){
       public long getLong(String k,long d){return prefs.containsKey(k)?prefs.get(k):d;}
       public Editor edit(){return new Editor(){
         public Editor putLong(String k,long v){prefs.put(k,v);return this;}
         public void apply(){}
       };}
     };
   }
 }''',
 'android/app/Dialog': 'public class Dialog { public void dismiss(){} }',
 'android/util/Log': 'public class Log { public static int w(String t,String m,Throwable e){return 0;} }',
 'android/content/Intent': '''public class Intent {public static String ACTION_CREATE_DOCUMENT="create",ACTION_OPEN_DOCUMENT="open",CATEGORY_OPENABLE="openable",EXTRA_TITLE="title",EXTRA_LOCAL_ONLY="local";public String action,type,pkg,title,category;public boolean local;public Intent inner;public Intent(String s){action=s;}public Intent(Intent i){action=i.action;type=i.type;local=i.local;category=i.category;}public Intent addCategory(String s){category=s;return this;}public Intent setType(String s){type=s;return this;}public Intent setPackage(String p){pkg=p;return this;}public void putExtra(String k,String s){title=s;}public void putExtra(String k,boolean b){local=b;}public static Intent createChooser(Intent i,String title){Intent c=new Intent("chooser");c.inner=i;return c;} }''',
 'android/content/pm/ActivityInfo': 'public class ActivityInfo { public String packageName;public boolean exported=true; }',
 'android/content/pm/ResolveInfo': 'public class ResolveInfo { public ActivityInfo activityInfo=new ActivityInfo(); }',
 'android/content/pm/PackageManager': '''public class PackageManager {public static final int MATCH_SYSTEM_ONLY=1,MATCH_DEFAULT_ONLY=2;public String system;public ResolveInfo resolveActivity(android.content.Intent i,int flags){if(flags!=3)throw new AssertionError("must resolve system/default only");if(!i.pkg.equals(system))return null;ResolveInfo r=new ResolveInfo();r.activityInfo.packageName=system;return r;}}''',
 'android/content/ActivityNotFoundException': 'public class ActivityNotFoundException extends RuntimeException {}',
 'android/net/Uri': 'public class Uri {public String getScheme(){return "content";}}',
 'android/view/Gravity': 'public class Gravity { public static final int CENTER = 17; }',
 'android/view/View': '''public class View {
   public static final int GONE=8,VISIBLE=0;
   public int visibility=VISIBLE;
   public Object parent;
   public Object getParent(){return parent;}
   public int getVisibility(){return visibility;}
   public void setVisibility(int v){visibility=v;}
   public void setPadding(int a,int b,int c,int d){}
   public void setMinimumHeight(int n){}
   public void setBackground(Object d){}
   public void setLayoutParams(Object p){}
   public void setClickable(boolean b){}
   public void setFocusable(boolean b){}
   public interface Click{void click(View v);}
   public Click listener;
   public void setOnClickListener(Click c){listener=c;}
 }''',
 'android/view/ViewGroup': '''public class ViewGroup extends View {
   public java.util.List<View> children=new java.util.ArrayList<>();
   public void removeAllViews(){children.clear();}
   public void addView(View v){v.parent=this;children.add(v);}
   public void addView(View v,LayoutParams p){addView(v);}
   public static class LayoutParams{
     public static final int MATCH_PARENT=-1,WRAP_CONTENT=-2;
     public int topMargin,bottomMargin,leftMargin,rightMargin;
     public LayoutParams(){}
     public LayoutParams(int w,int h){}
     public LayoutParams(int w,int h,float wt){}
     public LayoutParams(int w,int h,int g){}
   }
 }''',
 'android/widget/FrameLayout': '''public class FrameLayout extends android.view.ViewGroup {
   public FrameLayout(android.content.Context c){}
   public static class LayoutParams extends android.view.ViewGroup.LayoutParams {
     public LayoutParams(int w,int h){super(w,h);}
     public LayoutParams(int w,int h,int g){super(w,h,g);}
   }
 }''',
 'android/widget/LinearLayout': '''public class LinearLayout extends android.view.ViewGroup {
   public static class LayoutParams extends android.view.ViewGroup.LayoutParams {
     public LayoutParams(){}
     public LayoutParams(int w,int h){super(w,h);}
     public LayoutParams(int w,int h,float wt){super(w,h,wt);}
   }
 }''',
 'android/widget/ScrollView': 'public class ScrollView extends android.view.ViewGroup {public ScrollView(android.app.Activity a){} public void setFillViewport(boolean b){}}',
 'android/widget/TextView': 'public class TextView extends android.view.View {public String text;public void setText(String s){text=s;} public void setTextColor(int i){}}',
 'android/widget/Switch': 'public class Switch extends TextView {public Switch(android.app.Activity a){}public void setChecked(boolean b){}public interface Change{void run(Object o,boolean b);}public void setOnCheckedChangeListener(Change c){}}',
 'android/widget/ProgressBar': 'public class ProgressBar extends android.view.View {public ProgressBar(android.app.Activity a,Object b,int c){}public void setIndeterminate(boolean b){}public void setProgress(int i){}}',
 'org/json/JSONObject': 'public class JSONObject { public JSONObject(String s){} public String optString(String k,String d){return d;} }',
 'com/whaleonebot/ContainerService': 'public class ContainerService {public static ContainerService bindingStatus(android.app.Activity a,String s){return new ContainerService();}public String optString(String k){return "";}}',
 'com/whaleonebot/backup/CoreBackupSaf': 'public class CoreBackupSaf {' + ''.join('public static void '+n+'(Object... a){}' for n in ('release','deleteBackup','restore','exportAndRelease','export')) + '}',
 'com/whaleonebot/ui/HostDoubles': '''import android.widget.*;import android.view.*;import android.app.*;import java.util.*;
class Screen {AppShell shell;Activity activity;Theme t=new Theme();LinearLayout root=new LinearLayout();Screen(AppShell s){shell=s;activity=s.activity;} int dp(int n){return n;}LinearLayout header(String s){return new LinearLayout();}AppShell host(){return shell;} void build(){} void refresh(){} boolean handleBack(){return false;}}
class AppShell {Activity activity=new Activity();void corePage(String s,String id){}void toast(String s){}}
class Theme {boolean dark;int accent,textPrimary,textSecondary,textTertiary;static int S1,S2,S3,S4,T_BODY,T_CAP,T_CARD,TOUCH,R_TILE;}
class Drawables {static Object round(int a,int b,int c,int d){return new Object();}}
class IconView extends View {static final int TUNE=1,CHAT=2,CHEV_R=3; IconView(Activity a,int i,int c){}}
class PromptSheet {
  interface ItemClick { void onSelect(int idx); }
  static Runnable confirm;
  static Dialog confirm(Activity a,Theme t,String title,String msg,String pos,Runnable onPos,String neu,Runnable onNeu,String neg){confirm=onPos;return new Dialog();}
  static Dialog choose(Activity a,Theme t,String title,String[] items,ItemClick onSel,String ext,Runnable onExt){return new Dialog();}
}
class Ui {
  static final int TONE_NEUTRAL=0,TONE_OK=1,TONE_WARN=2,TONE_DANGER=3;
  static int alpha(int c,float f){return c;}
  static void press(View v,float f){}
  static LinearLayout column(Activity a){return new LinearLayout();}
  static LinearLayout row(Activity a){return new LinearLayout();}
  static LinearLayout addCard(LinearLayout parent,Activity a,Theme t,int top){FrameLayout f=new FrameLayout(a);LinearLayout box=new LinearLayout();f.addView(box);parent.addView(f);return box;}
  static View divider(Activity a,Theme t){return new View();}
  static LinearLayout.LayoutParams llp(int a,int b){return new LinearLayout.LayoutParams(a,b);}
  static TextView text(Activity a,String s,int b,int c){TextView v=new TextView();v.setText(s);return v;}
  static TextView strong(Activity a,String s,int b,int c){return text(a,s,b,c);}
  static TextView pill(Activity a,Theme t,String s,int tone){return text(a,s,0,0);}
  static TextView button(Activity a,Theme t,String s,boolean b){return text(a,s,0,0);}
  static String formatBytes(long bytes){if(bytes<1024)return bytes+" B";if(bytes<1048576)return String.format(java.util.Locale.ROOT,"%.1f KB",bytes/1024.0);return String.format(java.util.Locale.ROOT,"%.1f MB",bytes/1048576.0);}
  static String formatProgress(long done,long total){if(total<=0)return formatBytes(done);int pct=(int)Math.min(100,(done*100L)/total);return formatBytes(done)+" / "+formatBytes(total)+"（"+pct+"%）";}
  static String coreShortId(String id){return id!=null&&id.startsWith("core-")?id.substring(5):String.valueOf(id);}
  static String coreDisplayTitle(CoreInventory.Instance c){return c.ownerId.isEmpty()?"空闲核心":"b";}
  static String coreMetaLine(CoreInventory.Instance c){return "内置核心 · "+c.version+" · #"+coreShortId(c.id);}
}
class CoreInventory {static class Instance{String id="core-544",kind="builtin",ownerId="bot",version="1";boolean legacy;}}
class BotRegistry {static class Binding{String label(){return "";}}static class Bot{String name="b";List<Binding> bindings=new ArrayList<>();List<String> platforms=Arrays.asList("qq","bilibili");}static Bot get(String id){return new Bot();}static List<CoreInventory.Instance> cores(){return Collections.singletonList(new CoreInventory.Instance());}static String PLATFORM_LABEL(String s){return "qq".equals(s)?"QQ":s;}static void registerBuiltin(String a,String b){}}
class CoreImports {static void link(Object s){}static void register(Object s){}static void document(Object s,Object u){}}
class CoreBindingOps{static void reconcile(Object f,Object c){}}
class BoundStartScreen{static String summary(String s){return s;}}
class RemoteBridge{interface ProgressText{void onStatus(String s);} static boolean isRemote(){return false;} static void stageRemotePlugin(String a,String b,String c){} static void downloadRemoteCores(String a,int b){} static void releaseRemoteCore(String a,String b){} static void remoteBackupTransfer(Activity a,String b,String c,String d,android.net.Uri u,ProgressText p){}}''',
 'com/whaleonebot/install/CoreInstaller': '''import java.io.*;import java.util.*;import android.app.Activity;
public class CoreInstaller {public static String fail;public static final java.util.concurrent.CountDownLatch reported=new java.util.concurrent.CountDownLatch(1),release=new java.util.concurrent.CountDownLatch(1);public static int creates;private Activity owner;public static CoreInstaller open(Activity a){CoreInstaller c=new CoreInstaller();c.owner=a;return c;}public static File active(File f,String id){return new File(f,id);}public static boolean auto(File f){return false;}public static void setAuto(File f,boolean b){}public static void rollback(File f,String s){}public List<String> versions(boolean b){return null;}public Map<String,String> pluginVersions(String s,boolean b){return null;}public interface Progress{void update(String s,long n,long total);default void phase(String label){} }public void stagePlugin(String id,String platform,String version,Progress p){}public long downloadBytes(String version,List<String> ps){return 20190;}public Map<String,String> install(String id,String version,List<String> ps,boolean stage,Progress p)throws IOException{Map<String,String> missing=new LinkedHashMap<>();if(ps.isEmpty()){creates++;if("environment".equals(fail))throw new IOException("DOWNLOAD_FAILED");p.update("environment",32768,65536);reported.countDown();try{if(!release.await(4,java.util.concurrent.TimeUnit.SECONDS))throw new IOException("TIMEOUT");}catch(InterruptedException e){throw new IOException(e);}}for(String name:ps){if(name.equals(fail)){missing.put(name,"fixture failure");continue;}File r=new File(active(owner.files,id),"src/platform-modules/"+name+"/.bot-module.json");r.getParentFile().mkdirs();r.createNewFile();p.update(name,1,1);}return missing;} }''',
 'com/whaleonebot/ui/TestPicker': '''import android.content.Intent;
public class TestPicker {
 static void check(boolean v,String s){if(!v)throw new AssertionError(s);}
 public static void main(String[] args){AppShell sh=new AppShell();CoreManagerScreen p=new CoreManagerScreen(sh,"backups",null);p.build();
 for(String pkg:new String[]{"com.google.android.documentsui","com.android.documentsui",null})for(String op:new String[]{"restore","delete"}){
   sh.activity.pm.system=pkg;p.pick(op,null);Intent i=sh.activity.launched;
   if(pkg==null){check("chooser".equals(i.action),"OEM fallback must avoid the default");i=i.inner;check(i.pkg==null,"portable SAF");}else check(pkg.equals(i.pkg),"prefer verified system picker");
   check("open".equals(i.action)&&"openable".equals(i.category)&&"*/*".equals(i.type)&&i.local,"local unknown extension");
   p.picked(null);check(p.op==null&&!p.busy,"cancel must consume pending action");
 }
 p.pick("descriptor",null);Intent descriptor=sh.activity.launched;check("open".equals(descriptor.action)&&"*/*".equals(descriptor.type)&&!descriptor.local&&descriptor.pkg==null,"unchanged descriptor flow");p.picked(null);
 p.pick("export",new CoreInventory.Instance());Intent save=sh.activity.launched;check("create".equals(save.action)&&"application/octet-stream".equals(save.type)&&save.local&&save.title.endsWith(".whalebackup"),"local export");}
}''',
 'com/whaleonebot/ui/TestDownloadRetry': '''import com.whaleonebot.install.CoreInstaller;import java.util.concurrent.TimeUnit;
public class TestDownloadRetry {
 static void start(CoreManagerScreen p)throws Exception{p.estimate("1",1,null,false);TestPage.drain(p);PromptSheet.confirm.run();}
 static void expectContains(CoreManagerScreen p,String sub)throws Exception{long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);do{p.refresh();if(p.status.text!=null&&p.status.text.contains(sub))return;Thread.yield();}while(System.nanoTime()<end);throw new AssertionError(p.status.text);}
 public static void main(String[] args)throws Exception{AppShell sh=new AppShell();CoreManagerScreen p=new CoreManagerScreen(sh,"download",null);p.build();CoreInstaller.fail="environment";start(p);expectContains(p,"DOWNLOAD_FAILED");CoreManagerScreen next=new CoreManagerScreen(sh,"download",null);next.build();expectContains(next,"DOWNLOAD_FAILED");if(CoreInstaller.creates!=1)throw new AssertionError("automatic retry");CoreInstaller.fail=null;CoreInstaller.release.countDown();start(next);expectContains(next,"成功创建 1 份核心");if(CoreInstaller.creates!=2)throw new AssertionError("wrong attempt count");}}
''',
 'com/whaleonebot/ui/TestDownload': '''import com.whaleonebot.install.CoreInstaller;import java.util.concurrent.TimeUnit;
public class TestDownload {public static void main(String[] args)throws Exception{
 AppShell sh=new AppShell();CoreManagerScreen first=new CoreManagerScreen(sh,"download",null);first.build();first.estimate("1",1,null,false);TestPage.drain(first);PromptSheet.confirm.run();
 if(!CoreInstaller.reported.await(2,TimeUnit.SECONDS)||first.handleBack())throw new AssertionError("download blocked back");
 CoreManagerScreen next=new CoreManagerScreen(sh,"download",null);next.build();if(!next.status.text.contains("32.0 KB / 64.0 KB")||!next.status.text.contains("50%"))throw new AssertionError(next.status.text);
 CoreManagerScreen.createCores(CoreInstaller.open(sh.activity),"1",1);CoreInstaller.release.countDown();long end=System.nanoTime()+TimeUnit.SECONDS.toNanos(2);do{next.refresh();if(next.status.text.contains("成功创建 1 份核心"))break;Thread.yield();}while(System.nanoTime()<end);
 if(!next.status.text.contains("成功创建 1 份核心")||CoreInstaller.creates!=1)throw new AssertionError(next.status.text);}}''',
 'com/whaleonebot/ui/TestPage': '''import java.util.*;import java.io.*;import android.view.*;import android.widget.*;import com.whaleonebot.install.CoreInstaller;
public class TestPage {
 static void collect(View v,List<TextView> out){if(v instanceof TextView)out.add((TextView)v);if(v instanceof ViewGroup)for(View c:((ViewGroup)v).children)collect(c,out);}
 static TextView widgetContains(CoreManagerScreen p,String sub){List<TextView> all=new ArrayList<>();collect(p.col,all);for(TextView tv:all)if(tv.text!=null&&tv.text.contains(sub))return tv;throw new AssertionError("missing widget containing: "+sub+"; result: "+p.status.text);}
 static int countContains(CoreManagerScreen p,String sub){List<TextView> all=new ArrayList<>();collect(p.col,all);int n=0;for(TextView tv:all)if(tv.text!=null&&tv.text.contains(sub))n++;return n;}
 static void drain(CoreManagerScreen p)throws Exception{while(p.busy){Runnable r=p.activity.queue.poll(3,java.util.concurrent.TimeUnit.SECONDS);if(r==null)throw new AssertionError("no completion callback");r.run();}}
 static void install(CoreManagerScreen p)throws Exception{widgetContains(p,"安装缺失插件").listener.click(null);drain(p);if(PromptSheet.confirm==null)throw new AssertionError("missing confirmation");Runnable ok=PromptSheet.confirm;PromptSheet.confirm=null;ok.run();drain(p);}
 public static void main(String[] args)throws Exception{AppShell sh=new AppShell();sh.activity.files=new File(args[0]);CoreManagerScreen p=new CoreManagerScreen(sh,"plugins","core-544");p.build();widgetContains(p,"QQ");widgetContains(p,"bilibili");if(countContains(p,"待安装")!=2)throw new AssertionError("expected 2 pending");boolean partial=args.length>1;CoreInstaller.fail=partial?"bilibili":null;install(p);
 if(partial){if(countContains(p,"已装")!=1||countContains(p,"待安装")!=1)throw new AssertionError("expected 1 installed + 1 pending");if(!p.status.text.contains("待重试 [bilibili]"))throw new AssertionError(p.status.text);CoreInstaller.fail=null;install(p);}
 if(countContains(p,"已装")!=2||countContains(p,"待安装")!=0)throw new AssertionError("expected 2 installed");if(!p.status.text.contains("插件安装完成"))throw new AssertionError(p.status.text);}
}''',
}

class PluginScreenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp=tempfile.TemporaryDirectory();cls.addClassCleanup(tmp.cleanup)
        cls.root=root=Path(tmp.name);cls.classes=root/'classes';cls.classes.mkdir();sources=[]
        for key,body in STUBS.items():
            file=root/(key+'.java');file.parent.mkdir(parents=True,exist_ok=True)
            package=key.rsplit('/',1)[0].replace('/','.')
            file.write_text(f'package {package};\n{body}',encoding='utf-8');sources.append(file)
        subprocess.run(['javac','--release','8','-Xlint:-options','-encoding','UTF-8','-d',cls.classes,SCREEN,*sources],check=True)

    def test_retry_after_failed_download(self):
        subprocess.run(['java','-cp',self.classes,'com.whaleonebot.ui.TestDownloadRetry'],check=True,timeout=15)

    def test_return_to_active_download(self):
        subprocess.run(['java','-cp',self.classes,'com.whaleonebot.ui.TestDownload'],check=True,timeout=15)

    def test_backup_picker_routing_and_cancel(self):
        subprocess.run(['java','-cp',self.classes,'com.whaleonebot.ui.TestPicker'],check=True,timeout=15)

    def test_install_and_retry_on_same_screen(self):
        for scenario in ('success','partial'):
            with self.subTest(scenario=scenario):
                subprocess.run(['java','-cp',self.classes,'com.whaleonebot.ui.TestPage',self.root/scenario,*(['partial'] if scenario=='partial' else [])],check=True,timeout=15)

if __name__=='__main__': unittest.main()
