import urllib.request, json, http.cookiejar
cj = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
data = json.dumps({"email":"xinhua1001@outlook.com"}).encode()
opener.open(urllib.request.Request("http://127.0.0.1:8449/auth/send-code", data=data, headers={"Content-Type":"application/json"}))
data = json.dumps({"email":"xinhua1001@outlook.com","code":"000000"}).encode()
opener.open(urllib.request.Request("http://127.0.0.1:8449/auth/verify-code", data=data, headers={"Content-Type":"application/json"}))
resp = opener.open(urllib.request.Request("http://127.0.0.1:8449/sessions/9/bills"))
data = json.loads(resp.read())
for b in data[:3] + data[-5:]:
    print(b.get('id'), b.get('description'), '->', b.get('occurred_at'))