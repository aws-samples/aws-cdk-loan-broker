# Loan Broker with AWS CDK

This project is an AWS Cloud Development Kit (CDK) implementation of Gregor Hohpe's [Loan Broker example](https://www.enterpriseintegrationpatterns.com/ramblings/loanbroker_stepfunctions.html).

The purpose is to show how serverless orchestration with integration patterns could be implemented with [CDK](https://aws.amazon.com/cdk).

## Table of content
- [Overview](#overview)
- [Loan Broker implementations](#loan-broker-implementations)
  * [Recipient List](#recipient-list)
  * [Publish Subscribe](#publish-subscribe)
- [Usage](#usage)
  * [Bootstrap your environment](#bootstrap-your-environment)
  * [Initial deployment](#initial-deployment)
  * [Pre-populate LoanBrokerBanksTable for RecipientsList stack](#pre-populate-loanbrokerbankstable-for-recipientslist-stack)
  * [Execute loan broker request](#execute-loan-broker-request)
  * [Destroy the stacks](#destroy-the-stacks)
- [Security](#security)
- [License](#license)

## Overview

The example application demonstrates a basic integration scenario, which consists of several steps:
1. A Customer submits a loan application with personal data and desired terms, such as loan amount and duration.
2. The Loan Broker enriches the request with the customer's credit score retrieved from the Credit Bureau.
3. The Loan Broker submits the application to multiple Banks.
4. The Banks reply with a loan offer if they are willing to service the loan.
5. The Loan Broker aggregates the results, for example by selecting the best offer.
6. The Loan Broker returns the result(s) to the Customer.

![Loan Broker - Overview](https://www.enterpriseintegrationpatterns.com/img/ConsumerLoanBroker.gif)


## Loan Broker implementations
### Recipient List

[This version](lib/LoanBroker-RecipientList-stack.ts) uses the [Recipient List](https://www.enterpriseintegrationpatterns.com/patterns/messaging/RecipientList.html) pattern, meaning the Loan Broker first retrieves a list of banks to request quotes from.
For more details, see [here](https://www.enterpriseintegrationpatterns.com/ramblings/loanbroker_stepfunctions.html).

![Recipient List - Architecture overview](https://www.enterpriseintegrationpatterns.com/img/step-function-recipient-list.png)

### Publish Subscribe
In order to be able to dynamically route loan application to multiple banks [this version](lib/LoanBroker-PubSub-stack.ts) uses the [Scatter Gather](https://www.enterpriseintegrationpatterns.com/patterns/messaging/RecipientList.html) pattern, meaning the Loan Broker does not require to know upfront how many banks there are or how they are implemented.
For more details, see [here](https://www.enterpriseintegrationpatterns.com/ramblings/loanbroker_stepfunctions_pubsub.html).

![Scatter Gather - Architecture overview](https://www.enterpriseintegrationpatterns.com/img/step-function-pub-sub-summary.png)


## Usage
### Bootstrap your environment
```
cdk bootstrap aws://ACCOUNT-NUMBER/REGION       # e.g. cdk bootstrap aws://123456789012/us-east-1
```

For more details, see [AWS Cloud Development Kit](https://docs.aws.amazon.com/cdk/latest/guide/bootstrapping.html).

### Initial deployment
```
cdk deploy LoanBroker-RecipientList-Stack
cdk deploy LoanBroker-PubSub-Stack
```

### Pre-populate LoanBrokerBanksTable for RecipientsList stack
```
aws dynamodb put-item \
    --table-name=LoanBrokerBanksTable \
    --item='{ "Type": { "S": "Home" }, "BankAddress": {"L": [ { "S": "BankRecipientPremium" }, { "S": "BankRecipientUniversal" }, { "S": "BankRecipientPawnshop" } ] } }'
```

### Execute loan broker request

In order to start the state machine, execute:
```
aws stepfunctions start-execution \
    --name=cli-test-run \
    --state-machine-arn=STATE_MACHINE_ARN \
    --input="{\"SSN\": \"123-45-6789\", \"Amount\": 500000, \"Term\": 30 }"
```

You can use the resulting state machine ARN that is included in the CDK output.

The result contains the execution ARN, that is needed to request the output, e.g:
```
{
    "executionArn": "STATE_MACHINE_ARN:cli-test-run",
    "startDate": "2021-12-01T13:37:00.000000+00:00"
}
```

To see the output of the state machine execution, execute this:
```
aws stepfunctions describe-execution \
    --execution-arn=STATE_MACHINE_ARN:cli-test-run \
    --query="output" | jq -r  '. | fromjson'
```

This will result in:
```
{
   "Credit": { "Score": 693, "History": 24 },
   "Amount": 600000,
   "Quotes": [
    { "rate": 5.271301238502866, "bankId": "Universal" },
    { "rate": 3.8970175730277457, "bankId": "Premium" }
   ],
  "Term": 30,
  "SSN": "123-45-6789"
}
```




### Destroy the stacks
```
cdk destroy --all
```


## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This project is licensed under the Apache-2.0 License.

