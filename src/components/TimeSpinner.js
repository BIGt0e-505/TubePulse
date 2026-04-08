import React, { useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
  withSpring,
} from 'react-native-reanimated';
import { COLORS } from '../utils/constants';

const ITEM_HEIGHT = 44;
const SENSITIVITY = 1.8; // px per unit

function TimeSpinner({ value, onChange }) {
  const [h, m] = value.split(':').map(Number);
  const pad = (n) => String(n).padStart(2, '0');

  const hourOffset = useSharedValue(0);
  const minuteOffset = useSharedValue(0);

  const commitHour = useCallback((delta) => {
    const newH = ((h + delta) % 24 + 24) % 24;
    onChange(`${pad(newH)}:${pad(m)}`);
  }, [h, m, onChange]);

  const commitMinute = useCallback((delta) => {
    const totalMins = m + delta * 15;
    const newH = ((h + Math.floor(totalMins / 60)) % 24 + 24) % 24;
    const newM = ((totalMins % 60) + 60) % 60;
    onChange(`${pad(newH)}:${pad(newM)}`);
  }, [h, m, onChange]);

  const makeGesture = (offset, onEnd) => {
    let accumulated = 0;
    return Gesture.Pan()
      .onBegin(() => {
        accumulated = 0;
      })
      .onUpdate((e) => {
        offset.value = e.translationY;
        const steps = Math.floor(-e.translationY / (ITEM_HEIGHT / SENSITIVITY));
        accumulated = steps;
      })
      .onEnd((e) => {
        const steps = Math.round(-e.translationY / (ITEM_HEIGHT / SENSITIVITY));
        offset.value = withSpring(0, { damping: 20, stiffness: 300 });
        if (steps !== 0) runOnJS(onEnd)(steps);
      });
  };

  const hourGesture = makeGesture(hourOffset, commitHour);
  const minuteGesture = makeGesture(minuteOffset, commitMinute);

  const hourAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: hourOffset.value * 0.3 }],
  }));

  const minuteAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: minuteOffset.value * 0.3 }],
  }));

  return (
    <View style={styles.container}>
      {/* Hour column */}
      <GestureDetector gesture={hourGesture}>
        <View style={styles.column}>
          <Animated.View style={hourAnimStyle}>
            <Text style={styles.digit}>{pad(h)}</Text>
          </Animated.View>
          <Text style={styles.hint}>drag</Text>
        </View>
      </GestureDetector>

      <Text style={styles.colon}>:</Text>

      {/* Minute column */}
      <GestureDetector gesture={minuteGesture}>
        <View style={styles.column}>
          <Animated.View style={minuteAnimStyle}>
            <Text style={styles.digit}>{pad(m)}</Text>
          </Animated.View>
          <Text style={styles.hint}>drag</Text>
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 4,
  },
  column: {
    alignItems: 'center',
    width: 52,
    height: 58,
    justifyContent: 'center',
  },
  digit: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: '700',
    lineHeight: 38,
  },
  colon: {
    color: COLORS.text,
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 16,
  },
  hint: {
    color: COLORS.textDim,
    fontSize: 10,
    marginTop: 2,
    opacity: 0.6,
  },
});

export default TimeSpinner;
