// Copyright 2015 The Cockroach Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
// implied. See the License for the specific language governing
// permissions and limitations under the License.
//
// Author: Vivek Menezes (vivek@cockroachlabs.com)

package sql

import (
	"github.com/cockroachdb/cockroach/pkg/roachpb"
	"github.com/cockroachdb/cockroach/pkg/sql/parser"
	"github.com/cockroachdb/cockroach/pkg/storage/engine/enginepb"
	"github.com/pkg/errors"
)

// BeginTransaction starts a new transaction.
func (p *planner) BeginTransaction(n *parser.BeginTransaction) (planNode, error) {
	if p.txn == nil {
		return nil, errors.Errorf("the server should have already created a transaction")
	}
	if err := p.setIsolationLevel(n.Isolation); err != nil {
		return nil, err
	}
	if err := p.setUserPriority(n.UserPriority); err != nil {
		return nil, err
	}
	return &emptyNode{}, nil
}

// SetTransaction sets a transaction's isolation level
func (p *planner) SetTransaction(n *parser.SetTransaction) (planNode, error) {
	if err := p.setIsolationLevel(n.Isolation); err != nil {
		return nil, err
	}
	if err := p.setUserPriority(n.UserPriority); err != nil {
		return nil, err
	}
	return &emptyNode{}, nil
}

func (p *planner) setIsolationLevel(level parser.IsolationLevel) error {
	var iso enginepb.IsolationType
	switch level {
	case parser.UnspecifiedIsolation:
		return nil
	case parser.SnapshotIsolation:
		iso = enginepb.SNAPSHOT
	case parser.SerializableIsolation:
		iso = enginepb.SERIALIZABLE
	default:
		return errors.Errorf("unknown isolation level: %s", level)
	}

	return p.session.TxnState.setIsolationLevel(iso)
}

func (p *planner) setUserPriority(userPriority parser.UserPriority) error {
	var up roachpb.UserPriority
	switch userPriority {
	case parser.UnspecifiedUserPriority:
		return nil
	case parser.Low:
		up = roachpb.MinUserPriority
	case parser.Normal:
		up = roachpb.NormalUserPriority
	case parser.High:
		up = roachpb.MaxUserPriority
	default:
		return errors.Errorf("unknown user priority: %s", userPriority)
	}
	return p.session.TxnState.setPriority(up)
}
