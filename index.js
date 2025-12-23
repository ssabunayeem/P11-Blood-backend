const { MongoClient, ServerApiVersion } = require("mongodb");
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const port = process.env.PORT || 5000;
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const admin = require("firebase-admin");
const { log } = require("console");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const verifyToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorize access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded info", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorize access" });
  }
};

const uri = "mongodb+srv://p11-blood:qlVhNI4Emh7u1lZf@cluster0.atr0nay.mongodb.net/?appName=Cluster0";


// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    // await client.connect();     // nayeem
    // Send a ping to confirm a successful connection

    const dataBase = client.db("p9-bloodDB");
    const userCollections = dataBase.collection("user");
    const requestCollections = dataBase.collection("request");
    const paymentsCollections = dataBase.collection("payments");

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
      res.status(200).send(result);
    });

    app.get(`/users/role/:email`, async (req, res) => {
      const { email } = req.params;
      const query = { email: email };
      const result = await userCollections.findOne(query);
      console.log(result);
      res.send(result);
    });

    app.patch("/update/user/status", verifyToken, async (req, res) => {
      const { email, status } = req.query;
      const query = { email: email };
      const updateStatus = {
        $set: {
          status: status,
        },
      };
      const result = await userCollections.updateOne(query, updateStatus);
      res.send(result);
    });

    // request

    app.post("/requests", verifyToken, async (req, res) => {
      const data = req.body;
      data.createdAt = new Date();
      const result = await requestCollections.insertOne(data);
      res.send(result);
    });

    app.get("/my-request", verifyToken, async (req, res) => {
      const email = req.decoded_email;
      const size = Number(req.query.size);
      const page = Number(req.query.page);
      const query = { requester_email: email };

      const result = await requestCollections
        .find(query)
        .limit(size)
        .skip(size * page)
        .toArray();
      const totalRequest = await requestCollections.countDocuments(query);

      res.send({ request: result, totalRequest });
    });

    app.get("/requests-search", async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;
      const query = {};
      if (!query) {
        return;

        query.requester_district = district;
      }
      if (upazila) {
        query.requester_upazila = upazila;
      }
      const result = await requestCollections.find(query).toArray();
      res.send(result);
    });

    //payments

    app.post("/create-payment-checkout", async (req, res) => {
      const information = req.body;
      const amount = parseInt(information.donateAmount) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: "please donate",
              },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          donorName: information?.donorName,
        },
        customer_email: information?.donorEmail,
        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    //new
    app.post("/success-payment", async (req, res) => {
      const { session_id } = req.query;
      const session = await stripe.checkout.sessions.retrieve(session_id);
      console.log(session);

      const transactionId = session.payment_intent;

      const isPaymentExist = await paymentsCollections.findOne({
        transactionId,
      });
      if (isPaymentExist) {
        console.log("Nayeem");

        return res.status(400).send("Already Exist");
      }

      console.log("after verify");

      if (session.payment_status == "paid") {
        const paymentInfo = {
          amount: session.amount_total / 100,
          currency: session.currency,
          donorEmail: session.customer_email,
          transactionId,
          payment_status: session.payment_status,
          paidAt: new Date(),
        };
        const result = await paymentsCollections.insertOne(paymentInfo);
        return res.send(result);
      }
    });


    app.patch("/update/profile", verifyToken, async (req, res) => {
      const { email } = req.query;
      const updatedData = req.body;

      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }

      const query = { email };
      const updateDoc = {
        $set: {
          name: updatedData.name,
          district: updatedData.district,
          upozila: updatedData.upozila,
          bloodGroup: updatedData.bloodGroup,
          photoURL: updatedData.photoURL,
          updatedAt: new Date(),
        },
      };

      const result = await userCollections.updateOne(query, updateDoc);
      res.send(result);
    });



    // Nayeem->

    /* await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    ); */

    // <-nayeem//



  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello, Mission SCIC ");
});

app.listen(port, () => {
  console.log(`Server is running on ${port}`);
});


