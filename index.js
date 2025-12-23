const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

// ================= FIREBASE ADMIN =================
const admin = require("firebase-admin");
const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8");
const serviceAccount = JSON.parse(decodedKey);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ================= APP SETUP =================
const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ================= VERIFY TOKEN =================
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "Unauthorized" });
  }

  try {
    const token = authHeader.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "Unauthorized" });
  }
};

// ================= MONGODB =================
const uri =
  "mongodb+srv://p11-blood:qlVhNI4Emh7u1lZf@cluster0.atr0nay.mongodb.net/?appName=Cluster0";

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("p9-bloodDB");

    const userCollections = db.collection("user");
    const requestCollections = db.collection("request");
    const paymentsCollections = db.collection("payments");

    // ================= USERS =================
    app.post("/users", async (req, res) => {
      const userInfo = req.body;
      userInfo.role = "donor";
      userInfo.status = "active";
      userInfo.createdAt = new Date();
      const result = await userCollections.insertOne(userInfo);
      res.send(result);
    });

    app.get("/users", verifyToken, async (req, res) => {
      const result = await userCollections.find().toArray();
      res.send(result);
    });

    app.get("/users/role/:email", async (req, res) => {
      const result = await userCollections.findOne({ email: req.params.email });
      res.send(result);
    });

    app.patch("/update/user/status", verifyToken, async (req, res) => {
      const { email, status } = req.query;
      const result = await userCollections.updateOne(
        { email },
        { $set: { status } }
      );
      res.send(result);
    });

    // ================= PROFILE UPDATE =================
    app.patch("/update/profile", verifyToken, async (req, res) => {
      const email = req.query.email;
      const data = req.body;

      const result = await userCollections.updateOne(
        { email },
        {
          $set: {
            name: data.name,
            phone: data.phone,
            age: data.age,
            gender: data.gender,
            address: data.address,
            district: data.district,
            upozila: data.upozila,
            bloodGroup: data.bloodGroup,
            photoURL: data.photoURL,
            updatedAt: new Date(),
          },
        }
      );

      res.send(result);
    });



    // PATCH: update name, mainUrl (photoURL), and/or status
    app.patch("/update/user", verifyToken, async (req, res) => {
      const { email, name, mainUrl, status } = req.body;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const updateData = {};
      if (name) updateData.name = name;
      if (mainUrl) updateData.mainUrl = mainUrl; // matches frontend `user.mainUrl`
      if (status) updateData.status = status;
      updateData.updatedAt = new Date();

      try {
        const result = await userCollections.findOneAndUpdate(
          { email },
          { $set: updateData },
          { returnDocument: "after" } // returns updated user
        );

        res.send(result.value); // send updated user object
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Update failed" });
      }
    });



    // Get all donation requests (Admin)
    // Admin: all requests with filter & pagination
    app.get("/admin/requests", verifyToken, async (req, res) => {
      const email = req.decoded_email;
      const user = await userCollections.findOne({ email });

      if (!user || !["admin", "volunteer"].includes(user.role)) {
        return res.status(403).send({ message: "Forbidden" });
      }

      const requests = await requestCollections
        .find()
        .sort({ createdAt: -1 })
        .toArray();

      res.send(requests);
    });





    // Admin Dashboard Stats
    app.get("/admin/stats", verifyToken, async (req, res) => {
      const totalUsers = await userCollections.countDocuments();
      const totalRequests = await requestCollections.countDocuments();
      const totalFunds = await paymentsCollections
        .aggregate([
          { $group: { _id: null, total: { $sum: "$amount" } } },
        ])
        .toArray();

      res.send({
        totalUsers,
        totalRequests,
        totalFunds: totalFunds[0]?.total || 0,
      });
    });


    // ================= DONATION REQUEST =================
    app.post("/requests", verifyToken, async (req, res) => {
      const data = req.body;
      data.createdAt = new Date();
      const result = await requestCollections.insertOne(data);
      res.send(result);
    });

    // My Requests (Pagination)
    app.get("/my-request", verifyToken, async (req, res) => {
      const email = req.decoded_email;
      const size = Number(req.query.size);
      const page = Number(req.query.page);

      const query = { requester_email: email };

      const requests = await requestCollections
        .find(query)
        .skip(size * page)
        .limit(size)
        .toArray();

      const totalRequest = await requestCollections.countDocuments(query);

      res.send({ request: requests, totalRequest });
    });

    // Recent 3 requests (Dashboard)
    app.get("/dashboard/recent-requests", verifyToken, async (req, res) => {
      const email = req.decoded_email;

      // check user role
      const user = await userCollections.findOne({ email });

      let query = {};

      if (user.role === "donor") {
        // donor only see own recent 3
        query = { requester_email: email };
      } else if (user.role === "admin") {
        // admin sees global recent 3
        query = {};
      }

      const result = await requestCollections
        .find(query)
        .sort({ createdAt: -1 })
        .limit(3)
        .toArray();

      res.send(result);
    });

    // Update donation status
    app.patch("/requests/update/status/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;

      try {
        const email = req.decoded_email;
        const user = await userCollections.findOne({ email });

        if (!user || !["admin", "volunteer"].includes(user.role)) {
          return res.status(403).send({ message: "Forbidden" });
        }

        const result = await requestCollections.updateOne(
          { _id: new ObjectId(id) },
          { $set: { donation_status: status } }
        );

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Server error" });
      }
    });


    // Update donation request
    app.patch("/requests/edit/:id", verifyToken, async (req, res) => {
      const { id } = req.params;
      const data = req.body;

      try {
        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            requester_name: data.requester_name,
            requester_district: data.requester_district,
            requester_upazila: data.requester_upazila,
            hospitalName: data.hospitalName,
            fullAddress: data.fullAddress,
            bloodGroup: data.bloodGroup,
            donationDate: data.donationDate,
            donationTime: data.donationTime,
            requestMessage: data.requestMessage,
          },
        };

        const result = await requestCollections.updateOne(filter, updateDoc);

        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Update failed" });
      }
    });


    // Edit request (only pending)
    app.patch("/requests/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const data = req.body;

      const result = await requestCollections.updateOne(
        { _id: new ObjectId(id), donation_status: "pending" },
        {
          $set: {
            hospitalName: data.hospitalName,
            fullAddress: data.fullAddress,
            donationDate: data.donationDate,
            donationTime: data.donationTime,
            requestMessage: data.requestMessage,
          },
        }
      );

      res.send(result);
    });

    // Get single request by id
    app.get("/requests/:id", async (req, res) => {
      const { id } = req.params;
      try {
        const request = await requestCollections.findOne({
          _id: new ObjectId(id),
        });
        res.send(request);
      } catch (err) {
        res.status(500).send({ message: "Failed to load request" });
      }
    });


    // get all pending donation requests
    app.get("/pending-requests", async (req, res) => {
      try {
        const result = await requestCollections
          .find({ donation_status: "pending" })
          .toArray();
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to load pending requests" });
      }
    });


    // Delete request
    app.delete("/requests/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const result = await requestCollections.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // ================= SEARCH =================
    app.get("/requests-search", async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;
      const query = {};

      if (bloodGroup) query.bloodGroup = bloodGroup;
      if (district) query.requester_district = district;
      if (upazila) query.requester_upazila = upazila;

      const result = await requestCollections.find(query).toArray();
      res.send(result);
    });

    // ================= PAYMENT =================
    app.post("/create-payment-checkout", async (req, res) => {
      const info = req.body;
      const amount = parseInt(info.donateAmount) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: { name: "Donation" },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        customer_email: info.donorEmail,
        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    app.get("/payments", verifyToken, async (req, res) => {
      try {
        const payments = await paymentsCollections
          .find()
          .sort({ paidAt: -1 }) // latest first
          .toArray();
        res.send(payments);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch payments" });
      }
    });

    app.post("/success-payment", async (req, res) => {
      const session = await stripe.checkout.sessions.retrieve(
        req.query.session_id
      );

      if (session.payment_status === "paid") {
        const paymentInfo = {
          donorEmail: session.customer_email,
          amount: session.amount_total / 100,
          transactionId: session.payment_intent,
          paidAt: new Date(),
        };
        const result = await paymentsCollections.insertOne(paymentInfo);
        res.send(result);
      }
    });
  } finally {
  }
}

run().catch(console.dir);

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("Blood Donation Server Running");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
