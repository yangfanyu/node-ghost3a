import 'dart:async';
import 'package:wssnet_ghost3a/wssnet_ghost3a.dart';

void testWssClient() {
  Ghost3a net = Ghost3a('http://localhost:8082/', '123', true, heartick: 3);
  net.setLogLevel(Ghost3a.LOG_LEVEL_ALL);
  net.connect(([List<dynamic> params]) {
    print('onopen');
  }, (int code, String reason, [List<dynamic> params]) {
    print('onclose $code $reason');
  }, (String error, [List<dynamic> params]) {
    print('onerror $error');
  }, (int count, [List<dynamic> params]) {
    print('onretry $count');
  }, (int second, int delay, [List<dynamic> params]) {
    //    print('onsecond $second $delay');
  });

  Timer(Duration(seconds: 60), () {
    net.disconnect();
  });
}

void main() {
  testWssClient();
}
