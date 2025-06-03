const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const readline = require("readline");
const user_agents = require("./config/userAgents");
const settings = require("./config/config.js");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson, getRandomElement } = require("./utils/utils.js");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { checkBaseUrl } = require("./checkAPI");
const { headers } = require("./core/header.js");
const { showBanner } = require("./core/banner.js");
const localStorage = require("./localStorage.json");
const { jwtDecode } = require("jwt-decode");

class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL) {
    this.headers = headers;
    this.baseURL = baseURL;
    this.baseURL_v2 = settings.BASE_URL_v2;
    this.localItem = null;
    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = null;
    this.localStorage = localStorage;
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.itemData.email;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[Pharos][${this.accountIndex + 1}][${this.session_name}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 2,
      isAuth: false,
      extraHeaders: {},
      refreshToken: null,
    }
  ) {
    const { retries, isAuth, extraHeaders, refreshToken } = options;

    const headers = {
      ...this.headers,
      ...extraHeaders,
    };

    if (!isAuth && this.token) {
      headers["cookie"] = `${this.token}`;
    }

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
    }

    let currRetries = 0,
      errorMessage = "",
      errorStatus = 0;
    let responseHeader = null;
    do {
      try {
        // const requestData = method.toLowerCase() !== "get" ? data : undefined;

        const response = await axios({
          method,
          url: `${url}`,
          headers,
          timeout: 120000,
          ...(proxyAgent ? { httpsAgent: proxyAgent, httpAgent: proxyAgent } : {}),
          ...(method.toLowerCase() !== "get" ? { data: data } : {}),
        });
        if (response?.data?.data) return { responseHeader: response.headers, status: response.status, success: true, data: response.data.data };
        return { responseHeader: response.headers, success: true, data: response.data, status: response.status };
      } catch (error) {
        errorMessage = error?.response?.data?.error || error.message;
        errorStatus = error.status;
        this.log(`Request failed: ${url} | ${JSON.stringify(errorMessage)}...`, "warning");

        if (error.status === 401) {
          if (url.includes("auth/loginWithFirebase")) {
            const isExpired = isTokenExpired(this.itemData.token);
            if (isExpired) {
              this.log(`Token is exprired. You need get token again manually!`, "warning");
              await sleep(1);
              process.exit(1);
            }
          }
          const token = await this.getValidToken(true);
          if (!token) {
            process.exit(1);
          }
          this.token = token;
          return this.makeRequest(url, method, data, options);
        }
        if (error.status === 400) {
          this.log(`Invalid request for ${url}, maybe have new update from server | contact: https://t.me/airdrophuntersieutoc to get new update!`, "error");
          return { success: false, status: error.status, error: errorMessage, data: null };
        }
        if (error.status === 429) {
          this.log(`Rate limit ${error.message}, waiting 30s to retries`, "warning");
          await sleep(60);
        }
        await sleep(settings.DELAY_BETWEEN_REQUESTS);
        currRetries++;
        if (currRetries > retries) {
          return { status: error.status, success: false, error: errorMessage, data: null };
        }
      }
    } while (currRetries <= retries);

    return { status: errorStatus, success: false, error: errorMessage, data: null };
  }

  getCookieData(setCookie) {
    try {
      if (!(setCookie?.length > 0)) return null;
      let cookie = [];
      const item = JSON.stringify(setCookie);
      // const item =
      const nonceMatch = item.match(/spheron.sid=([^;]+)/);
      if (nonceMatch && nonceMatch[0]) {
        cookie.push(nonceMatch[0]);
      }
      const data = cookie.join(";");
      return cookie.length > 0 ? data : null;
    } catch (error) {
      this.log(`Error get cookie: ${error.message}`, "error");
      return null;
    }
  }

  async lookUp(idToken) {
    const result = await this.makeRequest(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyAm-bNxwgSmnrF1KMeZzOhwiojF-bcDL4A`,
      "post",
      {
        idToken,
      },
      {
        isAuth: true,
        extraHeaders: {
          "x-client-version": "Chrome/JsCore/11.6.1/FirebaseCore-web",
          "x-firebase-gmpid": "1:530523974052:web:49096853a16b913cb37931",
        },
      }
    );
  }

  async getIdToken(sessionId) {
    const result = await this.makeRequest(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=AIzaSyAm-bNxwgSmnrF1KMeZzOhwiojF-bcDL4A`,
      "post",
      {
        requestUri:
          "https://whitelistingcampaign.firebaseapp.com/__/auth/handler?state=AMbdmDkYKG_83Z17NvZk_LCk30SWBra67pDTPalQ_4_I1_iHJSQ-1MpJ6QiITphKXdy5wt5jWlf3nm4NQS7zkZHtnliogsJ7QfE6x8aa-ILN-VzQ775wyTYuhag9jHfRjP7Nt0qeyp0CyTZH9mIHqH8LppuxQgOpnc-n6Cboz1fz_JhMMTBxvyYYAIGj_idEV5L6eY0CNbp5XpIyM68rdpc26qed__tRaKft3s_Lfh_6kEJKBSPCzh9mrmhoO27xKxO7omyr-v1Qp-6K6eosAD8IlE4XaiqAI-Du_SfYY_XiSK9DD8GB3hiJpIlYLBcjM0xs236UmoEZYVF1yQMd&code=4%2F0AUJR-x79PSb__6MAF1ew8KlL4JwZiThkSpGyAttL6-dF5hqAc2GxU2XasWoTZ1DYhRNs2Q&scope=email%20profile%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email%20openid&authuser=3&prompt=consent",
        sessionId: "xxx",
        returnSecureToken: true,
        returnIdpCredential: true,
      },
      {
        isAuth: true,
        extraHeaders: {
          "x-client-version": "Chrome/JsCore/11.6.1/FirebaseCore-web",
          "x-firebase-gmpid": "1:530523974052:web:49096853a16b913cb37931",
        },
      }
    );

    return result;
  }

  async auth() {
    // const res = await this.getIdToken();
    // if (!res.success) {
    //   this.log(`Unauth token!`, "warning");
    //   return null;
    // }
    // const idToken = res.data.idToken;
    const result = await this.makeRequest(
      `${this.baseURL}/auth/loginWithFirebase`,
      "post",
      {
        idToken: this.itemData.token,
      },
      { isAuth: true }
    );
    if (result.success) {
      const cookie = result.responseHeader["set-cookie"].join(";");
      return cookie;
    }
    return null;
  }

  async getUserData() {
    return this.makeRequest(`${this.baseURL}/auth/me`, "get");
  }

  async applyCode() {
    return this.makeRequest(`${this.baseURL}/referral/submit`, "post", {
      referralCode: settings.REF_CODE,
    });
  }
  async spin() {
    return this.makeRequest(`${this.baseURL}/user/spin`, "post", {
      type: "paid",
    });
  }

  async sendCodeToMail() {
    return this.makeRequest(`${this.baseURL}/user/generate-promo-code`, "post", {});
  }

  async applyProMoCode(promoCode) {
    return this.makeRequest(`${this.baseURL}/user/apply-promo-code`, "post", {
      promoCode: promoCode,
    });
  }

  async getValidToken(isNew = false) {
    const existingToken = this.token;
    // const { isExpired: isExp, expirationDate } = isTokenExpired(existingToken);

    // this.log(`Access token status: ${isExp ? "Expired".yellow : "Valid".green} | Acess token exp: ${expirationDate}`);
    if (existingToken && !isNew) {
      this.log("Using valid token", "success");
      return existingToken;
    }

    this.log("No found token or experied, trying get new token...", "warning");
    const loginRes = await this.auth();
    if (!loginRes) {
      this.log(`Auth failed: ${JSON.stringify(loginRes)}`, "error");
      return null;
    }
    if (loginRes) {
      await saveJson(this.session_name, JSON.stringify({ token: loginRes }), "localStorage.json");
      return loginRes;
    }
    this.log("Can't get new token...", "warning");
    return null;
  }

  async handleApplyCode(useData) {
    this.log(`Checking promocode...`);
    let { welcomePromoCode, referredBy } = useData;
    if (!referredBy) {
      await this.applyCode();
    }

    if (!welcomePromoCode) {
      this.log(`Sending promocode...`);

      await this.sendCodeToMail();
      const newUserData = await this.getUserData();
      if (newUserData.success) {
        welcomePromoCode = newUserData.data.welcomePromoCode;
        const result = await this.applyProMoCode(welcomePromoCode.promoCode);
        if (result.success) {
          this.log(`Apply promoCode ${welcomePromoCode.promoCode} success!`, "success");
        } else {
          this.log(`Apply promocode failed | ${JSON.stringify(result)}`, "warning");
        }
      }
    } else {
      const { isApplied, promoCode } = welcomePromoCode;
      if (!isApplied) {
        const result = await this.applyProMoCode(promoCode);
        if (result.success) {
          this.log(`Apply promocode ${promoCode}  success!`, "success");
        } else {
          this.log(`Apply promocode failed | ${JSON.stringify(result)}`, "warning");
        }
      }
    }
    return;
  }

  async handleSpin(useData) {
    const { wheelOfFortune } = useData;
    if (wheelOfFortune == null || wheelOfFortune?.spinsLeft > 0) {
      const result = await this.spin();
      if (result.success) {
        this.log(`${result.data.message}`, "success");
      } else {
        this.log(`Failed checkin ${JSON.stringify(result)}`, "warning");
      }
    } else {
      const lastestSpin = wheelOfFortune?.updatedAt ? new Date(wheelOfFortune.updatedAt).toLocaleString() : null;
      this.log(`No spin avalibale! Lastest Spin: ${lastestSpin || "Unknow"}`, "warning");
    }
  }

  async handleSyncData() {
    this.log(`Sync data...`);
    let userData = { success: false, data: null, status: 0 },
      retries = 0;

    do {
      userData = await this.getUserData();
      if (userData?.success) break;
      retries++;
    } while (retries < 1 && userData.status !== 400);

    if (userData?.success) {
      const { xpPoints, isWhitelisted, points, username, referralCode, referredBy, email, welcomePromoCode, wheelOfFortune } = userData.data;
      const whitelistPoints = wheelOfFortune?.spinPoints || 0 + welcomePromoCode?.promoPoints || 0;
      this.log(`User: ${email} | Ref code: ${referralCode} | whitelistPoints: ${whitelistPoints} | Xp: ${xpPoints} | Total points: ${points || 0}`, "custom");
    } else {
      this.log("Can't sync new data...skipping", "warning");
    }
    return userData;
  }

  async runAccount() {
    const accountIndex = this.accountIndex;
    this.session_name = this.itemData.email;
    this.localItem = JSON.parse(this.localStorage[this.session_name] || "{}");
    this.token = this.localItem?.token;
    this.#set_headers();
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "error");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Tài khoản ${accountIndex + 1} | ${this.proxyIP} | Bắt đầu sau ${timesleep} giây...`.green);
      await sleep(timesleep);
    }

    const token = await this.getValidToken();
    if (!token) return;
    this.token = token;
    const userData = await this.handleSyncData();
    if (userData.success) {
      await sleep(1);
      await this.handleApplyCode(userData.data);
      await sleep(1);
      await this.handleSpin(userData.data);
    } else {
      return this.log("Can't get use info...skipping", "error");
    }
  }
}

async function runWorker(workerData) {
  const { itemData, accountIndex, proxy, hasIDAPI } = workerData;
  const to = new ClientAPI(itemData, accountIndex, proxy, hasIDAPI);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function main() {
  console.clear();
  showBanner();
  const initData = loadData("tokens.txt");
  const proxies = loadData("proxy.txt");

  if (initData.length == 0 || (initData.length > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy và data phải bằng nhau.".red);
    console.log(`Data: ${initData.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }
  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const resCheck = await checkBaseUrl();
  if (!resCheck.endpoint) return console.log(`Không thể tìm thấy ID API, có thể lỗi kết nỗi, thử lại sau!`.red);
  console.log(`${resCheck.message}`.yellow);

  console.log(`Initing data...`.blue);
  const data = initData.map((val, index) => {
    // const [email, token] = val.trim().split("|");
    const payload = jwtDecode(val);
    const item = {
      token: val,
      email: payload.email,
      cookie: null,
    };
    new ClientAPI(item, index, proxies[index], resCheck.endpoint, {}).createUserAgent();
    return item;
  });
  await sleep(1);
  while (true) {
    let currentIndex = 0;
    const errors = [];
    while (currentIndex < data.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, data.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI: resCheck.endpoint,
            itemData: data[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex % proxies.length],
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              // console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error?.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < data.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    await sleep(3);
    console.log(`=============${new Date().toLocaleString()} | Hoàn thành tất cả tài khoản | Chờ ${settings.TIME_SLEEP} phút=============`.magenta);
    showBanner();
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}
