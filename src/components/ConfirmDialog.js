import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../utils/constants';

/**
 * In-app confirm dialog. Matches the app's dark theme.
 *
 * Replaces the platform-native Alert.alert which renders as the
 * system's default (light gray, blue text on Android) and clashes
 * with TubePulse's design.
 *
 * Usage:
 *   const ok = await confirm({
 *     title: 'Remove channel?',
 *     message: 'This will stop tracking @channel.',
 *     confirmText: 'Remove',
 *     cancelText: 'Cancel',
 *     destructive: true,
 *   });
 *   if (ok) { ...do the thing... }
 *
 * Or render directly:
 *   <ConfirmDialog
 *     visible={state.show}
 *     title="..."
 *     message="..."
 *     onConfirm={() => ...}
 *     onCancel={() => ...}
 *   />
 */
export default function ConfirmDialog({
  visible,
  title,
  message,
  confirmText = 'OK',
  cancelText = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}) {
  // Animate the card's opacity and scale for a smooth enter.
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.96)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, speed: 20, bounciness: 6, useNativeDriver: true }),
      ]).start();
    } else {
      opacity.setValue(0);
      scale.setValue(0.96);
    }
  }, [visible, opacity, scale]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onCancel}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Animated.View
          style={[
            styles.card,
            { opacity, transform: [{ scale }] },
          ]}
        >
          {/* Stop the backdrop's onPress from firing when the card itself is tapped */}
          <Pressable onPress={() => {}}>
            {title ? <Text style={styles.title}>{title}</Text> : null}
            {message ? <Text style={styles.message}>{message}</Text> : null}
            <View style={styles.buttonRow}>
              <TouchableOpacity style={styles.cancelButton} onPress={onCancel} activeOpacity={0.7}>
                <Text style={styles.cancelButtonText}>{cancelText}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmButton, destructive ? styles.confirmButtonDestructive : styles.confirmButtonDefault]}
                onPress={onConfirm}
                activeOpacity={0.7}
              >
                <Text style={styles.confirmButtonText}>{confirmText}</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 24,
    // Subtle shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 8,
  },
  title: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    letterSpacing: -0.2,
  },
  message: {
    color: COLORS.textDim,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  cancelButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginRight: 8,
  },
  cancelButtonText: {
    color: COLORS.textDim,
    fontSize: 14,
    fontWeight: '600',
  },
  confirmButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    minWidth: 80,
    alignItems: 'center',
  },
  confirmButtonDefault: {
    backgroundColor: COLORS.accent,
  },
  confirmButtonDestructive: {
    backgroundColor: COLORS.danger,
  },
  confirmButtonText: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700',
  },
});
