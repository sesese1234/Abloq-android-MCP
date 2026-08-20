package e8;

// Compile-only stub. Flattened (not extending e8.h) on purpose: invoke-interface resolution
// walks the real interface hierarchy at runtime regardless of which interface reference the
// call site names, so this only needs to declare every method we actually call.
public interface j {
    j a();                      // parent node, null at root
    java.util.List b();         // children (unused by the dump - kept for interface completeness)
    boolean e();                // isClickable
    boolean f();                // isFocusable
    boolean h();                // isLongClickable
    boolean isCheckable();
    boolean isChecked();
    boolean isEnabled();
    boolean n();                // isSelected
    boolean w();                // isFocused
    int z();                    // visibility (0=visible, 8=gone)
    e8.d C();                   // bounds holder
    y7.a u();                   // resolved resource-id struct
    Integer v();                // windowId
    String o();                 // className
    CharSequence l();           // text
    CharSequence s();           // contentDescription
    CharSequence y();           // hintText
}
