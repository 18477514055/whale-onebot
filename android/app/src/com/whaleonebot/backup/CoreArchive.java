package com.whaleonebot.backup;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import java.util.regex.Pattern;

/** Portable logical records, not an archive of files. No paths, login slots or executable entries. */
public final class CoreArchive {
    static final int LIMIT=16*1024*1024, FIELD=1024*1024, ROWS=12000;
    static final String MAGIC="Whale.Core.Backup.1";
    static final Pattern PRIVATE=Pattern.compile("(?i)(?:\\b(?:sk-[a-z0-9_-]{12,}|AIza[\\w-]{30,}|Bearer\\s+[\\w./+=-]{5,})|-----BEGIN [^\\n]*PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization|SESSDATA|bili_jct|cookie|client[_-]?secret|session[_-]?id)[\\s\\\"']*[:=]\\s*[\\\"']?[^\\s\\\"',}]+)");
    public final String version,name,persona;
    public final List<String> platforms;
    final List<String[]> rows=new ArrayList<>();
    private final Set<List<String>> keys=new HashSet<>();
    final Map<String,String[]> slots=new LinkedHashMap<>(),scopes=new LinkedHashMap<>();
    private int total;
    static IOException invalid(){return new IOException("备份格式、内容或范围不受支持");}
    static void check(boolean pass) throws IOException {if(!pass)throw invalid();}
    static void text(String s,int max) throws IOException {check(s!=null && s.length()<=max && s.indexOf(0)<0 && !PRIVATE.matcher(s).find());}
    public CoreArchive(String version,String name,String persona,List<String> platforms)throws IOException{
        text(name,120);text(persona,32000);check(!name.trim().isEmpty() && version!=null && version.matches("[A-Za-z0-9][A-Za-z0-9._+-]{0,79}"));
        check(platforms!=null && !platforms.isEmpty() && platforms.size()<=2 && new HashSet<>(platforms).size()==platforms.size() && Arrays.asList("qq","bilibili").containsAll(platforms));
        this.version=version;this.name=name;this.persona=persona;this.platforms=Collections.unmodifiableList(new ArrayList<>(platforms));total=persona.getBytes(StandardCharsets.UTF_8).length+2048;
    }
    // Settings are deliberately numeric/boolean leaves only. No endpoints/providers, model credentials, bindings, paths or unknown keys.
    static final Set<String> BOOL=new HashSet<>(Arrays.asList("knowledge.enabled","livingMemory.enabled","livingMemory.shadowSemantic","livingMemory.allowPrivate","livingMemory.allowGlobal","memory.consolidateEnabled","memory.handoffEnabled","memory.useChatModel","memory.visibility.hidePrivateInGroup","memory.privateSharedContext","memory.crossScopeSharedContext","memory.episodic.enabled","memory.proactiveRecall.enabled","humanize.enabled","humanize.respectPersonaCard","humanize.shape.enabled","humanize.actions.enabled","humanize.replyDelay.enabled","humanize.antiAi.enabled","humanize.antiAi.blockSevere","humanize.personaState.enabled","humanize.relationship.enabled","proactive.enabled","proactive.groupEnabled","proactive.privateEnabled","proactive.followUpEnabled","proactive.selfWakeEnabled"));
    static final Set<String> DEC=new HashSet<>(Arrays.asList("proactive.probability"));
    static final Set<String> TEXT=new HashSet<>(Arrays.asList("persona.botName","persona.selfNickname","persona.roleText","persona.customRules","persona.behaviorProfile","persona.participation"));
    public void add(String type,String first,String second,String value)throws IOException{
        text(type,10);text(first,160);text(second,64);text(value,FIELD);int bytes=value.getBytes(StandardCharsets.UTF_8).length;check(bytes<=FIELD);
        String[] words=type.split("@",-1);String base=words[0];check(words.length<=2);if(words.length==2){check(Arrays.asList("persona","person","doc").contains(base)&&scopes.containsKey(words[1]));if(base.equals("person"))check(first.equals(slots.get(scopes.get(words[1])[0])[1]));}
        switch(base){
        case "slot":check(slots.size()<32&&first.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}")&&platforms.contains(second)&&Arrays.asList("shared","isolated").contains(value));for(String id:slots.keySet())check(!id.equalsIgnoreCase(first));slots.put(first,new String[]{first,second,value});break;
        case "scope":check(scopes.size()<100&&first.equals(String.valueOf(scopes.size()))&&slots.containsKey(second)&&value.matches("[1-9][0-9]{0,19}"));for(String[] existing:scopes.values())check(!existing[0].equals(second)||!existing[1].equals(value));scopes.put(first,new String[]{second,value});break;
        case "setting":check(second.isEmpty() && (TEXT.contains(first)&&value.length()<=32000 || BOOL.contains(first)&&("true".equals(value)||"false".equals(value)) || DEC.contains(first)&&value.matches("(?:0(?:\\.[0-9]{1,12})?|1(?:\\.0{1,12})?)")));break;
        case "person":check(platforms.contains(first)&&second.matches("[0-9]{1,20}")&&value.startsWith("{"));break;
        case "persona":check(first.matches("[\\p{L}\\p{N} _:@.-]{1,150}")&&second.isEmpty()&&value.startsWith("{"));break;
        case "doc":check(first.matches("[\\p{L}\\p{N} _.-]{1,115}\\.(?:md|txt)")&&!first.startsWith(".")&&!first.contains("..")&&second.matches("[0-9]{1,16}"));break;
        default:throw invalid();}
        check(rows.size()<ROWS && (total+=bytes+512)<LIMIT && keys.add(Arrays.asList(type,first,base.equals("person")?second:"")));
        rows.add(new String[]{type,first,second,value});
    }
    private static void put(DataOutput out,String s)throws IOException{byte[] b=s.getBytes(StandardCharsets.UTF_8);out.writeInt(b.length);out.write(b);}
    private static String get(DataInput in,int max)throws IOException{int n=in.readInt();check(n>=0&&n<=max);byte[] b=new byte[n];in.readFully(b);String s=new String(b,StandardCharsets.UTF_8);check(Arrays.equals(b,s.getBytes(StandardCharsets.UTF_8)));return s;}
    static MessageDigest sha(){try{return MessageDigest.getInstance("SHA-256");}catch(NoSuchAlgorithmException x){throw new AssertionError(x);}}
    public byte[] write(OutputStream stream)throws IOException{
        MessageDigest hash=sha();DigestOutputStream digest=new DigestOutputStream(stream,hash);DataOutputStream o=new DataOutputStream(digest);
        put(o,MAGIC);put(o,version);put(o,name);put(o,persona);o.writeInt(platforms.size());for(String p:platforms)put(o,p);o.writeInt(rows.size());for(String[] r:rows)for(String s:r)put(o,s);
        o.flush();byte[] sum=hash.digest();stream.write(sum);stream.flush();return sum;
    }
    public static CoreArchive read(InputStream stream,byte[] expected)throws IOException{
        check(stream!=null);MessageDigest hash=sha();DataInputStream i=new DataInputStream(new DigestInputStream(stream,hash));check(MAGIC.equals(get(i,64)));
        String version=get(i,80),name=get(i,512),persona=get(i,128000);int count=i.readInt();check(count>0&&count<=2);List<String> ps=new ArrayList<>();for(int j=0;j<count;j++)ps.add(get(i,16));CoreArchive archive=new CoreArchive(version,name,persona,ps);
        count=i.readInt();check(count>=0&&count<=ROWS);for(int j=0;j<count;j++) archive.add(get(i,24),get(i,640),get(i,64),get(i,FIELD));
        byte[] sum=hash.digest(),trailer=new byte[32];i.readFully(trailer);check(MessageDigest.isEqual(sum,trailer)&&(expected==null||MessageDigest.isEqual(sum,expected))&&i.read()==-1);return archive;
    }
}
