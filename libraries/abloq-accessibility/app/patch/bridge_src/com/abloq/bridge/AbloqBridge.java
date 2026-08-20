package com.abloq.bridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.json.JSONArray;
import org.json.JSONObject;

// Injected into the real Developer Assistant APK. Reuses the app's own AccessibilityService
// hierarchy dump (o7.a.e().g().d()) instead of reimplementing tree-walking. The only new logic
// here is: a headless adb-reachable trigger, and serializing what the app already captured.
//
// o7.a / q7.d / da.b / e8.j / e8.d / y7.a are always fully qualified below - o7.a and y7.a both
// simplify to "a", q7.d and e8.d both simplify to "d", so no two of these can be unqualified-
// imported into the same file without a collision.
public class AbloqBridge extends BroadcastReceiver {

    private static final String TAG = "AbloqBridge";
    public static final String ACTION_DUMP = "com.abloq.bridge.ACTION_DUMP";
    private static volatile boolean installed = false;

    public static void install(Context context) {
        if (installed) {
            return;
        }
        installed = true;
        try {
            Context appContext = context.getApplicationContext();
            IntentFilter filter = new IntentFilter(ACTION_DUMP);
            AbloqBridge receiver = new AbloqBridge();
            if (Build.VERSION.SDK_INT >= 33) {
                appContext.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                appContext.registerReceiver(receiver, filter);
            }
            Log.i(TAG, "installed, listening for " + ACTION_DUMP);
        } catch (Throwable t) {
            Log.e(TAG, "install failed", t);
        }
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            dumpToFile(context);
        } catch (Throwable t) {
            Log.e(TAG, "dump failed", t);
        }
    }

    private static void dumpToFile(Context context) throws Exception {
        q7.d provider = o7.a.e().g();
        if (provider == null) {
            throw new IllegalStateException("no q7.d instance - AbloqBridge.install() ran before o7.a was initialized?");
        }
        da.b hierarchy = provider.d();
        if (hierarchy == null) {
            throw new IllegalStateException("q7.d.d() returned null - no accessibility data provider registered yet");
        }
        List nodes = hierarchy.d();

        Map<Object, Integer> indexOf = new HashMap<Object, Integer>();
        for (int i = 0; i < nodes.size(); i++) {
            indexOf.put(nodes.get(i), Integer.valueOf(i));
        }

        JSONArray arr = new JSONArray();
        for (int i = 0; i < nodes.size(); i++) {
            e8.j node = (e8.j) nodes.get(i);
            JSONObject obj = new JSONObject();
            obj.put("index", i);

            e8.j parent = node.a();
            Integer parentIndex = (parent != null) ? indexOf.get(parent) : null;
            obj.put("parentIndex", parentIndex != null ? (Object) parentIndex : JSONObject.NULL);

            obj.put("windowId", node.v() != null ? (Object) node.v() : JSONObject.NULL);
            obj.put("className", node.o() != null ? node.o() : JSONObject.NULL);

            y7.a resId = node.u();
            if (resId != null && resId.h() != null) {
                obj.put("resourceId", resId.h() + ":" + resId.i() + "/" + resId.k());
                obj.put("resourceNumericId", resId.f());
            } else {
                obj.put("resourceId", JSONObject.NULL);
            }

            obj.put("text", node.l() != null ? node.l().toString() : JSONObject.NULL);
            obj.put("contentDescription", node.s() != null ? node.s().toString() : JSONObject.NULL);
            obj.put("hintText", node.y() != null ? node.y().toString() : JSONObject.NULL);

            obj.put("checkable", node.isCheckable());
            obj.put("checked", node.isChecked());
            obj.put("clickable", node.e());
            obj.put("longClickable", node.h());
            obj.put("focusable", node.f());
            obj.put("focused", node.w());
            obj.put("enabled", node.isEnabled());
            obj.put("selected", node.n());
            obj.put("visible", node.z() == 0);

            e8.d bounds = node.C();
            if (bounds != null && bounds.c != null) {
                JSONObject b = new JSONObject();
                b.put("left", bounds.c.left);
                b.put("top", bounds.c.top);
                b.put("right", bounds.c.right);
                b.put("bottom", bounds.c.bottom);
                obj.put("boundsInScreen", b);
            } else {
                obj.put("boundsInScreen", JSONObject.NULL);
            }

            arr.put(obj);
        }

        File dir = context.getExternalFilesDir(null);
        if (dir == null) {
            dir = context.getFilesDir();
        }
        File done = new File(dir, "abloq_dump.done");
        done.delete();
        File tmp = new File(dir, "abloq_dump.json.tmp");
        File out = new File(dir, "abloq_dump.json");
        FileOutputStream fos = new FileOutputStream(tmp);
        try {
            fos.write(arr.toString().getBytes("UTF-8"));
        } finally {
            fos.close();
        }
        if (!tmp.renameTo(out)) {
            throw new IllegalStateException("rename to abloq_dump.json failed");
        }
        FileOutputStream doneStream = new FileOutputStream(done);
        doneStream.close();

        Log.i(TAG, "dump written: " + nodes.size() + " nodes -> " + out.getAbsolutePath());
    }
}
