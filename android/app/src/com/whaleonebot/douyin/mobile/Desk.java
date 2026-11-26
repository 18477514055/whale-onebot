package com.whaleonebot.douyin.mobile;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.ArrayList;
import java.util.regex.Pattern;

/** Trusted in-process boundary. No I/O, device APIs, accounts, credentials or implicit UI. */
public final class Desk {
    public interface Clock { long elapsedMillis(); }
    private final Clock clock;
    private final LinkedHashMap<String, Slot> slots = new LinkedHashMap<>();
    public Desk(Clock clock) { this.clock = java.util.Objects.requireNonNull(clock); }
    public static final class Slot {
        public final String botId, accountId;
        private Request waiting;
        private Slot(String bot, String account) { botId=bot; accountId=account; }
    }
    private static String id(String s) {
        if(s==null || !s.matches("[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}")) throw new IllegalArgumentException("invalid identifier");
        return s;
    }
    public synchronized Slot bind(String bot, String account) {
        id(bot); id(account);
        for(Slot s:slots.values()) if(s.botId.equals(bot)||s.accountId.equals(account)) {
            if(s.botId.equals(bot)&&s.accountId.equals(account)) return s;
            throw new IllegalStateException("conflicting local binding");
        }
        Slot s=new Slot(bot,account); slots.put(bot,s); return s;
    }
    public synchronized boolean current(Slot s) { return s!=null && slots.get(s.botId)==s; }
    public synchronized Slot get(String bot) { return slots.get(bot); }
    public synchronized List<Slot> slots() { return new ArrayList<>(slots.values()); }
    public synchronized void unbind(Slot s) { if(current(s)) {slots.remove(s.botId); s.waiting=null; notifyAll();} }
    public static final class Request {
        public final Slot slot;
        public final String requestId,action,target,details;
        public final long deadline;
        private boolean granted;
        private Request(Slot s,String r,String a,String t,String d,long end) {
            slot=s; requestId=r; action=a; target=t; details=d; deadline=end;
        }
    }
    private static String visible(String text) {
        if(text==null || text.trim().isEmpty() || text.length()>8192) throw new IllegalArgumentException("invalid review text");
        for(int i=0;i<text.length();) { int cp=text.codePointAt(i); i+=Character.charCount(cp);
            if(Character.getType(cp)==Character.FORMAT || (Character.isISOControl(cp)&&cp!='\n')) throw new IllegalArgumentException("invisible review text");
        } return text;
    }
    /** Worker calls issue then await exactly once. Never convert timeout into a retry. */
    public synchronized Request issue(Slot s,String rid,String action,String target,String details,long ttlMillis) {
        if(!current(s)||ttlMillis<1||ttlMillis>120000) throw new IllegalArgumentException("invalid scope/deadline");
        if(pending(s)!=null) throw new IllegalStateException("busy");
        return s.waiting=new Request(s,id(rid),id(action),visible(target),visible(details),clock.elapsedMillis()+ttlMillis);
    }
    public synchronized Request pending(Slot s) {
        if(!current(s)) return null;
        if(s.waiting!=null && s.waiting.deadline<=clock.elapsedMillis()) {s.waiting=null;notifyAll();}
        return s.waiting;
    }
    /** Compares object identity: no ID lookup or user supplied replacement parameters. */
    public synchronized boolean decide(Slot s,Request r,boolean yes) {
        if(r==null || pending(s)!=r || r.granted) return false;
        if(yes) r.granted=true; else s.waiting=null;
        notifyAll(); return true;
    }
    public synchronized boolean await(Request r) {
        while(pending(r.slot)==r) {
            if(r.granted) {r.slot.waiting=null; notifyAll(); return true;}
            long ms=r.deadline-clock.elapsedMillis(); if(ms<=0) continue;
            try { wait(ms); } catch(InterruptedException e) { if(r.slot.waiting==r) r.slot.waiting=null;notifyAll();Thread.currentThread().interrupt();return false; }
        } return false;
    }
    /** Strict allowlist; never follows or fetches anything. Caption is discarded. */
    private static final Pattern CANDIDATE=Pattern.compile("https://(?:www\\.douyin\\.com/video/[0-9]{1,24}|v\\.douyin\\.com/[a-zA-Z0-9_-]{1,80}/?)");
    public static String candidate(String raw) {
        if(raw==null||raw.length()>4096) return null;
        String found=null;
        for(String part:raw.trim().split("\\s+")) {
            if(part.contains("://")) {
                if(found!=null || !CANDIDATE.matcher(part).matches()) return null;
                found=part;
            }
        } return found;
    }
    public static String backgroundOpportunity() { return "skipped_no_verified_background_provider"; }
}
