import type { GoldenFingerprint } from "../helpers/native-signal-golden-fixtures";

/**
 * GOLDEN behaviour fingerprints of the causal native engine (Slice 1 + 1b).
 *
 * Generated ONCE from the engine exactly as committed at
 * bc4fbb6be3b26146b9f4fe5c1ac7e47c546942e6, before any engine.ts refactor, by
 * running tests/helpers/native-signal-golden-fixtures.ts against it. Do not
 * regenerate to make a failing test pass: a mismatch means observable causal
 * behaviour changed. See tests/native-signal-golden.test.ts.
 */
export const NATIVE_SIGNAL_CAUSAL_GOLDEN: Readonly<Record<string, GoldenFingerprint>> = {
  "registration-all-tfs-both-colours": {
    "barCount": 5,
    "inputSha256": "96f1acf84d6608d5133a088a846023afb64f978e05a06211080e0e4ecfea8502",
    "configSha256": "b488dbd08512722c2d9164c137b5cd5e0486760deb2263910f456e67208a7761",
    "traceSha256": "61c3cebed080d45f934e97050c4c441a2696a0d4db896c7c228aea4d191b590e",
    "committedCandidateSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "immediateCandidateSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "registrationSha256": "14ffea8d7729bf2df6707943e7e843fb357ffa046c269a8119c69348f553a81e",
    "evictionSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "finalStateSha256": "c76d06d1c43645ce6280d293fdb14eff1a2bccc8641f761020d623eb64a5e3d7",
    "counts": {
      "registrations": 12,
      "evictions": 0,
      "committed": 0,
      "immediate": 0,
      "immediateBothProofs": 0,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 0,
      "finalLevels": 12,
      "finalNextLevelId": 12,
      "registrationsByTf": {
        "1D": 2,
        "1W": 2,
        "1M": 2,
        "3M": 2,
        "6M": 2,
        "12M": 2
      }
    }
  },
  "fifo-overflow": {
    "barCount": 13,
    "inputSha256": "3c52baf6fa5e18f496fcf795223388a60d6e8ac87014137a698ed164768a5796",
    "configSha256": "1c2245140f64f07a0b7e56bfc3dbb306d7469d59a70703a21312a4d2922ba0fd",
    "traceSha256": "29376d036fb50218a217f5dca2a7b3a58725308df0a6dacdf91cd229a4b7acea",
    "committedCandidateSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "immediateCandidateSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "registrationSha256": "655972fc549b9a641e84d8ee962412dcb9c0f1da93bea2e24fa8a3bfb7e1933b",
    "evictionSha256": "ef44160ec40624e2442f8804747c8d5d0cc80e87b78635c27b01d31fb94cf4f3",
    "finalStateSha256": "ec68193acadb6bfdf574082f081ed33e531ab5a44627ddf2dc342b407ba713db",
    "counts": {
      "registrations": 6,
      "evictions": 3,
      "committed": 0,
      "immediate": 0,
      "immediateBothProofs": 0,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 0,
      "finalLevels": 3,
      "finalNextLevelId": 6,
      "registrationsByTf": {
        "1D": 6
      }
    }
  },
  "arm-disarm-rearm-retest": {
    "barCount": 11,
    "inputSha256": "c9d0f13c5ae0838f6b6ee32980fb6636fcbe8d42f4512c3844bcd6471804ffdc",
    "configSha256": "333da569cbf959054dc280ff47d034b1e8e40979cda97cad7e594ce9314932a1",
    "traceSha256": "d62cac2657f3faed44accbb26445590bd8099edc5abb1d421a7b983d5c55d704",
    "committedCandidateSha256": "813803e35aef97b0e2740cead5b32819dab55dddf095f6a1da8a9a0ebb567b05",
    "immediateCandidateSha256": "36ea3665326cee7fd30d5cae60a15bbf2b5457e4ed96fbcdd6667816678ca586",
    "registrationSha256": "81481cd828cfaf526f591ba8b032c31dc4376b86da04cf11ed736647c1a9d73e",
    "evictionSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "finalStateSha256": "ed4a2157845b43f8b0a75bee3424f64e889527a481d34b306c174d5262579168",
    "counts": {
      "registrations": 1,
      "evictions": 0,
      "committed": 1,
      "immediate": 1,
      "immediateBothProofs": 1,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 0,
      "finalLevels": 1,
      "finalNextLevelId": 1,
      "registrationsByTf": {
        "1D": 1
      }
    }
  },
  "cooldown-and-wrong-side": {
    "barCount": 28,
    "inputSha256": "e94266eae06768101a12f77f0379f827f2c3e07642335763a119969e8823779e",
    "configSha256": "333da569cbf959054dc280ff47d034b1e8e40979cda97cad7e594ce9314932a1",
    "traceSha256": "961113639940b8565a53e606defea1f17fc1430728b64589de12859b3b6615e7",
    "committedCandidateSha256": "a60804bfbc6dfcbeec8a2189ee659884134ab498394d937f05a65ce0199f8ca7",
    "immediateCandidateSha256": "b8d233767fe9799e4db2784dfc8afa0b33560614cc032b82ef4d8b2afb8fb16a",
    "registrationSha256": "81481cd828cfaf526f591ba8b032c31dc4376b86da04cf11ed736647c1a9d73e",
    "evictionSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "finalStateSha256": "8f9d8d5812844846fa29f0da1bdc439c00d66ad77120ba0fd018e9e41df823b7",
    "counts": {
      "registrations": 1,
      "evictions": 0,
      "committed": 3,
      "immediate": 3,
      "immediateBothProofs": 3,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 0,
      "finalLevels": 1,
      "finalNextLevelId": 1,
      "registrationsByTf": {
        "1D": 1
      }
    }
  },
  "multiple-levels-same-bar": {
    "barCount": 18,
    "inputSha256": "4960227e0f07664bace0516a9fc34282be5473ea5a1506a7ad3cad5214ef11df",
    "configSha256": "333da569cbf959054dc280ff47d034b1e8e40979cda97cad7e594ce9314932a1",
    "traceSha256": "6eac873032cc4a602be2d5110fdeeb9c88b17c1abb79782e25a711a0a5ea7287",
    "committedCandidateSha256": "c25556d972ea90fd0b1249b655c0febc8b27da9bc1f2a14ae35051290c2b63a5",
    "immediateCandidateSha256": "5311c4eedd307c236e791d901126066949700071201972883875f2397076ec30",
    "registrationSha256": "b71e0f64ef6cfc364843d9823c6d79d319aaf3b2b445ea1504572d0696128b5f",
    "evictionSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "finalStateSha256": "0b0ad7c90eedd46f89fd92474b31eedf7de7387cea509205e34b37bea0d7b6da",
    "counts": {
      "registrations": 3,
      "evictions": 0,
      "committed": 3,
      "immediate": 3,
      "immediateBothProofs": 3,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 0,
      "finalLevels": 3,
      "finalNextLevelId": 3,
      "registrationsByTf": {
        "1D": 3
      }
    }
  },
  "immediate-proof-flags": {
    "barCount": 25,
    "inputSha256": "5148897d818ed4b42417bc02735c2d85e7fed5108eb4e85ffd7d2360826c7bc6",
    "configSha256": "333da569cbf959054dc280ff47d034b1e8e40979cda97cad7e594ce9314932a1",
    "traceSha256": "303d19fd9e17e8a16d61192a84b889fdd9e8763191ecd59c50144395f9b570bb",
    "committedCandidateSha256": "f43c60a91d59f222112aeefbfde78630866a4387df6c35b0a4ddc66225febf5a",
    "immediateCandidateSha256": "6e23b2794d72ff9d636d9cc3ab0e5bc1c0ac358db1807a0424af4941410e8f3f",
    "registrationSha256": "81481cd828cfaf526f591ba8b032c31dc4376b86da04cf11ed736647c1a9d73e",
    "evictionSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "finalStateSha256": "1cebffdd0debc17a6b33d9a01ea2c7a399c0de148ecfa9a576f07adf30dade4e",
    "counts": {
      "registrations": 1,
      "evictions": 0,
      "committed": 2,
      "immediate": 3,
      "immediateBothProofs": 2,
      "immediateBandUnproven": 1,
      "immediatePresenceUnproven": 0,
      "finalLevels": 1,
      "finalNextLevelId": 1,
      "registrationsByTf": {
        "1D": 1
      }
    }
  },
  "immediate-eviction-risk": {
    "barCount": 10,
    "inputSha256": "c6faf37a5ebb6be84856e54987fce56d67d15cc8353da2e40d4c802eaf9e3f22",
    "configSha256": "ffeb9de2dcb3ed3b134801a210ad8ac0280c3a785d473c684b48b5cc261f4b9c",
    "traceSha256": "8b50c9482b5fbd17524a7f6ceba94e7b04d2d30dfffbfe3f8c189c3d2aa7a292",
    "committedCandidateSha256": "603bf236644e5f0d99eee3f7763d58a128d0b66acc09c2dd4755c90094a479b5",
    "immediateCandidateSha256": "8820e4f2e401c18ea9bbbdfdf868cebe5cc35145b98662a0a2e64e21eec237f4",
    "registrationSha256": "37f5241df13dcceb932f841553f5244f22ecb8a79d4d0139b36ddb27cd5e3669",
    "evictionSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "finalStateSha256": "e1cf5d472b90329cf163981782d611299c33e578931ed5d651d9850ca5959cc5",
    "counts": {
      "registrations": 2,
      "evictions": 0,
      "committed": 1,
      "immediate": 1,
      "immediateBothProofs": 0,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 1,
      "finalLevels": 2,
      "finalNextLevelId": 2,
      "registrationsByTf": {
        "1D": 2
      }
    }
  },
  "production-15m-all-tfs-7pct": {
    "barCount": 133,
    "inputSha256": "d6fc9ae5637c0510e93b9fb1a7ff0a7c76b93cbd4c577b7a40f1fdb88c657ddb",
    "configSha256": "b488dbd08512722c2d9164c137b5cd5e0486760deb2263910f456e67208a7761",
    "traceSha256": "d2f95e584307fdbcfd5dd8678613d48931ab1f0fab6129a39e3e0758aaedd5d7",
    "committedCandidateSha256": "eee79608cacb03bbb599cf68aa31c4bfb0f4e09e842fc5de5c91357e378e58de",
    "immediateCandidateSha256": "4837fbf8f0895ce557901e1bd43c948c63db7baf69fddf25de356ca12c92e2f3",
    "registrationSha256": "ac492f7dff6f621a34a128ef045a3ceb3597640a23b30d610942c789cf656353",
    "evictionSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "finalStateSha256": "a18e360b900fb4b6e0552e13af045fafb81c7f96793560ef827ee7ca5f226dda",
    "counts": {
      "registrations": 1,
      "evictions": 0,
      "committed": 1,
      "immediate": 1,
      "immediateBothProofs": 1,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 0,
      "finalLevels": 1,
      "finalNextLevelId": 1,
      "registrationsByTf": {
        "1D": 1
      }
    }
  },
  "noisy-15m-all-tfs": {
    "barCount": 4000,
    "inputSha256": "c14839241fb44e47749db6a1408e2dd5a78a78674d677ad0e2234d13f83adfc4",
    "configSha256": "b488dbd08512722c2d9164c137b5cd5e0486760deb2263910f456e67208a7761",
    "traceSha256": "1d2f25d34503c2c24bd7559b4f7991b2c08db1bd2108b0c73e87a714376b6b51",
    "committedCandidateSha256": "3f03a601bba2d75f1318108407d66f5b3cf2a2bb928b620ffb39485d7a876a77",
    "immediateCandidateSha256": "3190cbef3807deff9f4a2f08a3fcc318db18cc87e770c3ef32f5228bc3961ff8",
    "registrationSha256": "24b435b4770664b224d96e1b45f3b0d04e2877c70c0b17c1a0c45209718ddaa9",
    "evictionSha256": "9fe1abc2c425c19c3580aacac108a254746b5c7cf2500a3136e5712136911254",
    "finalStateSha256": "cad2273a6af8525c6f120f3728f4a3fac942c9ee4ddcd1f19e322dabbfe0ada2",
    "counts": {
      "registrations": 1256,
      "evictions": 756,
      "committed": 3747,
      "immediate": 3747,
      "immediateBothProofs": 3676,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 71,
      "finalLevels": 500,
      "finalNextLevelId": 1256,
      "registrationsByTf": {
        "1D": 220,
        "1W": 221,
        "1M": 224,
        "3M": 197,
        "6M": 197,
        "12M": 197
      }
    }
  },
  "noisy-15m-retest-disabled": {
    "barCount": 4000,
    "inputSha256": "c14839241fb44e47749db6a1408e2dd5a78a78674d677ad0e2234d13f83adfc4",
    "configSha256": "e36166f78f50e939972edf6ec674fc03c16b7561e18ffc488674c6c3d1887111",
    "traceSha256": "910f5e4807334eb1f750fb8336ae89e6f0d0776851f06f27aa6850182a72fc67",
    "committedCandidateSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "immediateCandidateSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "registrationSha256": "24b435b4770664b224d96e1b45f3b0d04e2877c70c0b17c1a0c45209718ddaa9",
    "evictionSha256": "af9112b5c7831652be962e3c6e20abf308ecf026c057714dcdb73950adfbc2bd",
    "finalStateSha256": "ca0afb6e2d02d33b5c84e03ab748d526db711b9d01350780cc2fc240a44ad666",
    "counts": {
      "registrations": 1256,
      "evictions": 756,
      "committed": 0,
      "immediate": 0,
      "immediateBothProofs": 0,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 0,
      "finalLevels": 500,
      "finalNextLevelId": 1256,
      "registrationsByTf": {
        "1D": 220,
        "1W": 221,
        "1M": 224,
        "3M": 197,
        "6M": 197,
        "12M": 197
      }
    }
  },
  "noisy-15m-bar-close-timing": {
    "barCount": 4000,
    "inputSha256": "c14839241fb44e47749db6a1408e2dd5a78a78674d677ad0e2234d13f83adfc4",
    "configSha256": "2640bbeac200f1fe1fb403f0ef19150b8e72197f7c2f8bf276af8950fe110567",
    "traceSha256": "ff82da88d0d47b14f871e13049bf6f6cb2b9388a7215f80062793ba18d935207",
    "committedCandidateSha256": "3f03a601bba2d75f1318108407d66f5b3cf2a2bb928b620ffb39485d7a876a77",
    "immediateCandidateSha256": "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "registrationSha256": "24b435b4770664b224d96e1b45f3b0d04e2877c70c0b17c1a0c45209718ddaa9",
    "evictionSha256": "9fe1abc2c425c19c3580aacac108a254746b5c7cf2500a3136e5712136911254",
    "finalStateSha256": "ab792df72f464adca0585b2b04833de3c0305c0d5f29ae3923fd4097971d3f24",
    "counts": {
      "registrations": 1256,
      "evictions": 756,
      "committed": 3747,
      "immediate": 0,
      "immediateBothProofs": 0,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 0,
      "finalLevels": 500,
      "finalNextLevelId": 1256,
      "registrationsByTf": {
        "1D": 220,
        "1W": 221,
        "1M": 224,
        "3M": 197,
        "6M": 197,
        "12M": 197
      }
    }
  },
  "large-1h-seeded-fifo-40": {
    "barCount": 9600,
    "inputSha256": "ff99a7bd80cda811005f175fc2b01f8e48d8a2fce5cc777863d62de906cc6be0",
    "configSha256": "2444b0fdfdd847d563db80c705459107a436f2ff9d13b656e18d2d4f259a927f",
    "traceSha256": "1c00c921089350fcef1850df717be8d9939bcb1835950276ad9033d5691738f3",
    "committedCandidateSha256": "bdc0c97ac7651dfcb52245284053707dc4c6643f90772d9e55ef0d6debe3e08c",
    "immediateCandidateSha256": "660bb836f61cd978a490ca104717b916df1f8f2132fbf594731ff326bc0887ff",
    "registrationSha256": "08ca355dcc8349acf5e75f7e79c55984b4aff93c1b9599942cbda00a35b98ee2",
    "evictionSha256": "d15724592372daa55898b662a10ffb2967b614bc6fde0f6c6e610dad4aec3002",
    "finalStateSha256": "76ab2bba23ad58b2693d224410c4f31af0a33e78197b086c57349adab132b523",
    "counts": {
      "registrations": 3398,
      "evictions": 3358,
      "committed": 631,
      "immediate": 647,
      "immediateBothProofs": 370,
      "immediateBandUnproven": 0,
      "immediatePresenceUnproven": 277,
      "finalLevels": 40,
      "finalNextLevelId": 3398,
      "registrationsByTf": {
        "1D": 569,
        "1W": 730,
        "1M": 584,
        "3M": 524,
        "6M": 457,
        "12M": 534
      }
    }
  }
};
