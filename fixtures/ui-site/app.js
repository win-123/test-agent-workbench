const loginPanel = document.querySelector('#login-panel')
const workspace = document.querySelector('#workspace')
const loginForm = document.querySelector('#login-form')
const loginError = document.querySelector('#login-error')
const query = document.querySelector('#query')
const results = document.querySelector('#search-results')
const orderForm = document.querySelector('#order-form')
const orderResult = document.querySelector('#order-result')

const orders = [
  { id: 'ORD-1001', customer: 'Acme Studio', amount: '$1,240', status: 'Paid' },
  { id: 'ORD-1002', customer: 'Northwind', amount: '$890', status: 'Review' },
  { id: 'ORD-1003', customer: 'Bluebird Labs', amount: '$2,100', status: 'Paid' },
]

loginForm.addEventListener('submit', event => {
  event.preventDefault()
  const username = document.querySelector('#username').value
  const password = document.querySelector('#password').value
  if (username !== 'demo' || password !== 'demo123') {
    loginError.hidden = false
    return
  }
  loginError.hidden = true
  loginPanel.hidden = true
  workspace.hidden = false
  query.dispatchEvent(new Event('input'))
})

document.querySelector('#logout').addEventListener('click', () => {
  workspace.hidden = true
  loginPanel.hidden = false
})

query.addEventListener('input', () => {
  const term = query.value.trim().toLowerCase()
  const found = orders.filter(order => term.length === 0 || `${order.id} ${order.customer}`.toLowerCase().includes(term))
  results.innerHTML = `<table><thead><tr><th>Order</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead><tbody>${found.map(order => `<tr><td>${order.id}</td><td>${order.customer}</td><td>${order.amount}</td><td>${order.status}</td></tr>`).join('')}</tbody></table>`
})

orderForm.addEventListener('submit', event => {
  event.preventDefault()
  const customer = document.querySelector('#customer').value.trim()
  const priority = document.querySelector('#priority').value
  const fail = document.querySelector('#fail-mode').checked
  orderResult.hidden = false
  orderResult.className = fail ? 'result fail' : 'result'
  if (customer.length === 0) {
    orderResult.textContent = 'Customer is required.'
    return
  }
  orderResult.textContent = fail
    ? 'Order rejected: downstream inventory service is unavailable.'
    : `Order created for ${customer} with ${priority} priority.`
})
