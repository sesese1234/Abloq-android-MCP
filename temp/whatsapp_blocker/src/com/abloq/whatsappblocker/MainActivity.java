package com.abloq.whatsappblocker;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {

    private TextView tvStatus;
    private Button btnEnableService;
    private Button btnOpenWhatsApp;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        tvStatus = findViewById(R.id.tv_status);
        btnEnableService = findViewById(R.id.btn_enable_service);
        btnOpenWhatsApp = findViewById(R.id.btn_open_whatsapp);

        btnEnableService.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                startActivity(intent);
            }
        });

        btnOpenWhatsApp.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent launchIntent = getPackageManager().getLaunchIntentForPackage("com.whatsapp");
                if (launchIntent != null) {
                    startActivity(launchIntent);
                } else {
                    Toast.makeText(MainActivity.this, "WhatsApp is not installed", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateStatus();
    }

    private void updateStatus() {
        boolean isEnabled = isAccessibilityServiceEnabled(this, WhatsAppBlockerAccessibilityService.class);
        if (isEnabled) {
            tvStatus.setText(R.string.status_active);
            tvStatus.setTextColor(Color.parseColor("#2E7D32"));
            btnEnableService.setVisibility(View.GONE);
        } else {
            tvStatus.setText(R.string.status_inactive);
            tvStatus.setTextColor(Color.parseColor("#C62828"));
            btnEnableService.setVisibility(View.VISIBLE);
        }
    }

    private static boolean isAccessibilityServiceEnabled(Context context, Class<?> service) {
        String serviceId = context.getPackageName() + "/" + service.getName();
        int accessibilityEnabled = 0;
        try {
            accessibilityEnabled = Settings.Secure.getInt(
                    context.getContentResolver(),
                    Settings.Secure.ACCESSIBILITY_ENABLED
            );
        } catch (Settings.SettingNotFoundException e) {
            // ignore
        }

        if (accessibilityEnabled == 1) {
            String settingValue = Settings.Secure.getString(
                    context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            );
            if (settingValue != null) {
                TextUtils.SimpleStringSplitter colonSplitter = new TextUtils.SimpleStringSplitter(':');
                colonSplitter.setString(settingValue);
                while (colonSplitter.hasNext()) {
                    String componentName = colonSplitter.next();
                    if (componentName.equalsIgnoreCase(serviceId)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
}
