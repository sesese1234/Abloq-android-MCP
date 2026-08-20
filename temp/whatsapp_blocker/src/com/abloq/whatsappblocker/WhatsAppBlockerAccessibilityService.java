package com.abloq.whatsappblocker;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

public class WhatsAppBlockerAccessibilityService extends AccessibilityService {

    private static final String TAG = "WhatsAppBlocker";
    private static final String PACKAGE_WHATSAPP = "com.whatsapp";
    private static final String PACKAGE_WHATSAPP_W4B = "com.whatsapp.w4b";

    // Matches Updates / Status tab labels across languages
    private static final Pattern UPDATES_PATTERN = Pattern.compile(
            "(updates?|עדכון|עדכונים|סטטוס|status|novedad|actualizaci|mises?\\s+à\\s+jour|actus?|aktuell|aggiorn|обновлен|مסטג|مסטגד|حالة|حال|statut|stato)",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
    );

    // Matches Chats tab labels strictly (Note: 'שיחות' is Hebrew for Calls, NOT Chats!)
    private static final Pattern CHATS_TAB_PATTERN = Pattern.compile(
            "(chats?|צ['׳״\"]?אטים?|discussions?|conversations?|conversas?|درדשות|محادثות|чаты?)",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
    );

    // Matches other non-chats tabs (Calls, Communities, Updates) to assist negative matching
    private static final Pattern OTHER_TABS_PATTERN = Pattern.compile(
            "(updates?|עדכון|עדכונים|סטטוס|status|calls?|שיחות|appels?|llamadas?|chiamate|звонки|مكאל|קהילות|communities?|communautés?|comunidades?|сообщества)",
            Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE
    );

    private long lastActionTime = 0;
    private long lastToastTime = 0;
    private static final long ACTION_DEBOUNCE_MS = 250;
    private static final long TOAST_THROTTLE_MS = 2000;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;

        CharSequence pkgCharSeq = event.getPackageName();
        if (pkgCharSeq == null) return;
        String pkg = pkgCharSeq.toString();

        if (!PACKAGE_WHATSAPP.equals(pkg) && !PACKAGE_WHATSAPP_W4B.equals(pkg)) {
            return;
        }

        int eventType = event.getEventType();

        // 1. Direct click on tab
        if (eventType == AccessibilityEvent.TYPE_VIEW_CLICKED) {
            AccessibilityNodeInfo source = event.getSource();
            if (source != null) {
                AccessibilityNodeInfo tabItem = findTabItemFromNode(source);
                if (tabItem != null) {
                    if (isUpdatesNode(tabItem)) {
                        Log.i(TAG, "Direct tap on Updates tab item detected in bottom nav!");
                        handleBlockedNavigation();
                    }
                    tabItem.recycle();
                }
                source.recycle();
                return;
            }
        }

        // 2. Window / tab state changes
        if (eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED ||
            eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
            eventType == AccessibilityEvent.TYPE_VIEW_SELECTED ||
            eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED) {

            long now = System.currentTimeMillis();
            if (now - lastActionTime < ACTION_DEBOUNCE_MS) {
                return;
            }

            evaluateAndRedirectIfNeeded();
        }
    }

    private AccessibilityNodeInfo findTabItemFromNode(AccessibilityNodeInfo node) {
        if (node == null) return null;
        AccessibilityNodeInfo current = AccessibilityNodeInfo.obtain(node);
        while (current != null) {
            AccessibilityNodeInfo parent = current.getParent();
            if (parent != null) {
                String parentResId = parent.getViewIdResourceName();
                if (parentResId != null && parentResId.equals("com.whatsapp:id/bottom_nav")) {
                    parent.recycle();
                    return current;
                }
                AccessibilityNodeInfo grandParent = parent.getParent();
                if (grandParent != null) {
                    String grandParentResId = grandParent.getViewIdResourceName();
                    if (grandParentResId != null && grandParentResId.equals("com.whatsapp:id/bottom_nav")) {
                        parent.recycle();
                        grandParent.recycle();
                        return current;
                    }
                    grandParent.recycle();
                }
                parent.recycle();
            }
            AccessibilityNodeInfo next = current.getParent();
            current.recycle();
            current = next;
        }
        return null;
    }

    private void evaluateAndRedirectIfNeeded() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;

        try {
            if (isUpdatesCurrentlyActive(root)) {
                Log.i(TAG, "Updates tab or status screen detected as active! Redirecting...");
                handleBlockedNavigation();
            }
        } finally {
            root.recycle();
        }
    }

    private boolean isUpdatesCurrentlyActive(AccessibilityNodeInfo root) {
        if (root == null) return false;

        // 1. Check bottom nav if present (main screen)
        AccessibilityNodeInfo bottomNav = findBottomNavContainer(root);
        if (bottomNav != null) {
            try {
                return isUpdatesSelectedInNav(bottomNav);
            } finally {
                bottomNav.recycle();
            }
        }

        // 2. If bottom nav is NOT present (e.g. full-screen status viewer / channel screen)
        // Check for visible updates/status lists with actual screen width
        List<AccessibilityNodeInfo> updateLists = root.findAccessibilityNodeInfosByViewId("com.whatsapp:id/updates_list");
        if (updateLists != null && !updateLists.isEmpty()) {
            try {
                for (AccessibilityNodeInfo node : updateLists) {
                    if (isNodeActuallyVisible(node)) {
                        return true;
                    }
                }
            } finally {
                recycleList(updateLists);
            }
        }

        List<AccessibilityNodeInfo> statusLists = root.findAccessibilityNodeInfosByViewId("com.whatsapp:id/status_list");
        if (statusLists != null && !statusLists.isEmpty()) {
            try {
                for (AccessibilityNodeInfo node : statusLists) {
                    if (isNodeActuallyVisible(node)) {
                        return true;
                    }
                }
            } finally {
                recycleList(statusLists);
            }
        }

        return false;
    }

    private boolean isNodeActuallyVisible(AccessibilityNodeInfo node) {
        if (node == null || !node.isVisibleToUser()) return false;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        return bounds.width() > 100 && bounds.height() > 100;
    }

    private boolean isUpdatesSelectedInNav(AccessibilityNodeInfo bottomNav) {
        List<AccessibilityNodeInfo> navItems = getBottomNavItems(bottomNav);
        try {
            for (AccessibilityNodeInfo item : navItems) {
                if (item.isSelected() && isUpdatesNode(item)) {
                    return true;
                }
            }
        } finally {
            recycleList(navItems);
        }
        return false;
    }

    private void handleBlockedNavigation() {
        lastActionTime = System.currentTimeMillis();

        showBlockedToast();

        boolean redirected = clickChatsTab();
        if (!redirected) {
            Log.i(TAG, "Chats tab not clicked directly, triggering global BACK action as fallback.");
            performGlobalAction(GLOBAL_ACTION_BACK);
        }

        // Schedule a follow-up check after 150ms to verify navigation succeeded
        mainHandler.postDelayed(() -> {
            AccessibilityNodeInfo followUpRoot = getRootInActiveWindow();
            if (followUpRoot != null) {
                try {
                    if (isUpdatesCurrentlyActive(followUpRoot)) {
                        Log.i(TAG, "Follow-up verification: Updates still active, performing secondary redirect.");
                        if (!clickChatsTab()) {
                            performGlobalAction(GLOBAL_ACTION_BACK);
                        }
                    }
                } finally {
                    followUpRoot.recycle();
                }
            }
        }, 150);
    }

    private boolean clickChatsTab() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return false;

        try {
            AccessibilityNodeInfo bottomNav = findBottomNavContainer(root);
            if (bottomNav == null) return false;

            try {
                AccessibilityNodeInfo chatsTab = findChatsTabNode(bottomNav);
                if (chatsTab != null) {
                    try {
                        AccessibilityNodeInfo target = getClickableTarget(chatsTab);
                        if (target != null) {
                            boolean clicked = target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                            Log.i(TAG, "Executed ACTION_CLICK on Chats tab: " + clicked);
                            target.recycle();
                            return clicked;
                        }
                    } finally {
                        chatsTab.recycle();
                    }
                }
            } finally {
                bottomNav.recycle();
            }
        } finally {
            root.recycle();
        }
        return false;
    }

    private AccessibilityNodeInfo findChatsTabNode(AccessibilityNodeInfo bottomNav) {
        List<AccessibilityNodeInfo> navItems = getBottomNavItems(bottomNav);
        try {
            if (navItems.isEmpty()) return null;

            // Strategy 1: Explicit match on CHATS_TAB_PATTERN
            for (AccessibilityNodeInfo item : navItems) {
                if (isChatsNode(item)) {
                    return AccessibilityNodeInfo.obtain(item);
                }
            }

            // Strategy 2: Negative match - find item that is NOT Updates, Calls, or Communities
            for (AccessibilityNodeInfo item : navItems) {
                if (!isOtherTabNode(item)) {
                    return AccessibilityNodeInfo.obtain(item);
                }
            }

            // Strategy 3: Default to first item or rightmost in RTL
            return AccessibilityNodeInfo.obtain(navItems.get(navItems.size() - 1));
        } finally {
            recycleList(navItems);
        }
    }

    private List<AccessibilityNodeInfo> getBottomNavItems(AccessibilityNodeInfo bottomNav) {
        List<AccessibilityNodeInfo> items = new ArrayList<>();
        if (bottomNav == null) return items;

        int childCount = bottomNav.getChildCount();
        for (int i = 0; i < childCount; i++) {
            AccessibilityNodeInfo child = bottomNav.getChild(i);
            if (child != null) {
                int subCount = child.getChildCount();
                if (subCount > 0) {
                    for (int j = 0; j < subCount; j++) {
                        AccessibilityNodeInfo tabItem = child.getChild(j);
                        if (tabItem != null) {
                            items.add(tabItem);
                        }
                    }
                } else {
                    items.add(child);
                }
                child.recycle();
            }
        }
        return items;
    }

    private boolean isInsideBottomNav(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        while (current != null) {
            String resId = current.getViewIdResourceName();
            if (resId != null && (resId.contains("bottom_nav") || resId.contains("navigation_bar"))) {
                return true;
            }
            AccessibilityNodeInfo parent = current.getParent();
            if (current != node) {
                current.recycle();
            }
            current = parent;
        }
        return false;
    }

    private boolean isUpdatesNode(AccessibilityNodeInfo node) {
        String combined = collectAllText(node);
        return !combined.isEmpty() && UPDATES_PATTERN.matcher(combined).find();
    }

    private boolean isChatsNode(AccessibilityNodeInfo node) {
        String combined = collectAllText(node);
        return !combined.isEmpty() && CHATS_TAB_PATTERN.matcher(combined).find();
    }

    private boolean isOtherTabNode(AccessibilityNodeInfo node) {
        String combined = collectAllText(node);
        return !combined.isEmpty() && OTHER_TABS_PATTERN.matcher(combined).find();
    }

    private String collectAllText(AccessibilityNodeInfo node) {
        if (node == null) return "";
        StringBuilder sb = new StringBuilder();
        CharSequence text = node.getText();
        if (text != null && text.length() > 0) {
            sb.append(text).append(" ");
        }
        CharSequence desc = node.getContentDescription();
        if (desc != null && desc.length() > 0) {
            sb.append(desc).append(" ");
        }
        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                String childText = collectAllText(child);
                if (!childText.isEmpty()) {
                    sb.append(childText).append(" ");
                }
                child.recycle();
            }
        }
        return sb.toString().trim();
    }

    private AccessibilityNodeInfo findBottomNavContainer(AccessibilityNodeInfo root) {
        if (root == null) return null;
        List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByViewId("com.whatsapp:id/bottom_nav");
        if (nodes != null && !nodes.isEmpty()) {
            return nodes.get(0);
        }
        List<AccessibilityNodeInfo> containerNodes = root.findAccessibilityNodeInfosByViewId("com.whatsapp:id/bottom_nav_container");
        if (containerNodes != null && !containerNodes.isEmpty()) {
            return containerNodes.get(0);
        }
        return null;
    }

    private AccessibilityNodeInfo getClickableTarget(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isClickable()) {
            return AccessibilityNodeInfo.obtain(node);
        }
        AccessibilityNodeInfo current = node.getParent();
        while (current != null) {
            if (current.isClickable()) {
                return current;
            }
            AccessibilityNodeInfo next = current.getParent();
            current.recycle();
            current = next;
        }
        return AccessibilityNodeInfo.obtain(node);
    }

    private void showBlockedToast() {
        long now = System.currentTimeMillis();
        if (now - lastToastTime > TOAST_THROTTLE_MS) {
            lastToastTime = now;
            mainHandler.post(() -> {
                Toast.makeText(getApplicationContext(), getString(R.string.blocked_toast), Toast.LENGTH_SHORT).show();
            });
        }
    }

    private void recycleList(List<AccessibilityNodeInfo> list) {
        if (list == null) return;
        for (AccessibilityNodeInfo node : list) {
            if (node != null) {
                node.recycle();
            }
        }
        list.clear();
    }

    @Override
    public void onInterrupt() {
        Log.i(TAG, "Service Interrupted");
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        Log.i(TAG, "WhatsApp Blocker Accessibility Service connected!");
    }
}
