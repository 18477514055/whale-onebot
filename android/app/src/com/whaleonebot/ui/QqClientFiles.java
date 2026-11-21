package com.whaleonebot.ui;
import java.io.File;
/** File presence is not proof of protocol compatibility or a logged-in account. */
final class QqClientFiles {
    static final String OFFICIAL_PAGE="https://im.qq.com/linuxqq/index.shtml";
    static boolean present(File root){
        File executable=new File(root,"qq"),wrapper=new File(root,"resources/app/wrapper.node");
        return executable.isFile() && executable.length()>0 && wrapper.isFile() && wrapper.length()>0;
    }
    private QqClientFiles(){}
}
